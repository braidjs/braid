import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { build } from 'esbuild';

/**
 * A plain static server — no gateway, no Braid. It serves the shell, the worker and client
 * bundles, and the billing app's files at /billing-app/. Every /__braid/ URL the page uses is
 * answered by the service worker; if one ever reaches this server, it is a 404 and is logged.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
};

/** Bundles the worker and the page's runtime. `tsconfig` lets a monorepo resolve local sources. */
export async function bundle({ tsconfig } = {}) {
  const bundleOne = async (entry) => {
    const result = await build({
      entryPoints: [join(here, 'src', entry)],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
      logLevel: 'silent',
      ...(tsconfig ? { tsconfig } : {}),
    });
    return result.outputFiles[0].text;
  };
  const [sw, main] = await Promise.all([
    bundleOne('sw.js'),
    bundleOne('main.js'),
  ]);
  return { '/sw.js': sw, '/main.js': main };
}

/**
 * Starts the static server. `onRequest` sees every path it is asked for. `compress` ('zstd' or
 * 'gzip') encodes the billing app's responses when the request accepts it, as a CDN would.
 */
export async function start({ port = 0, bundles, onRequest, compress } = {}) {
  const scripts = bundles ?? (await bundle());
  const server = createServer(async (req, res) => {
    // a request-target such as `//` is not a URL, and any page can make a browser send one here
    let pathname;
    try {
      ({ pathname } = new URL(req.url, 'http://localhost'));
    } catch {
      res.writeHead(400).end();
      return;
    }
    onRequest?.(pathname);

    if (scripts[pathname]) {
      res
        .writeHead(200, {
          'content-type': TYPES['.js'],
          'cache-control': 'no-cache',
        })
        .end(scripts[pathname]);
      return;
    }
    if (pathname.startsWith('/__braid/')) {
      console.warn(
        `static server: ${pathname} reached the network — the worker is not in control`,
      );
      res.writeHead(404).end();
      return;
    }

    // each app is a single-page app: a path with no extension is a route, and gets its index.html
    const [app, path] = pathname.startsWith('/billing-app/')
      ? ['billing-app', pathname.slice('/billing-app'.length)]
      : ['shell', pathname];
    const file = join(app, extname(path) ? path : 'index.html');
    const resolved = normalize(join(here, 'public', file));
    if (!resolved.startsWith(join(here, 'public') + sep)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(resolved);
      const headers = {
        'content-type': TYPES[extname(resolved)] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
      };
      // the shell may be framed by nothing but itself
      if (app === 'shell') headers['x-frame-options'] = 'SAMEORIGIN';
      if (
        app === 'billing-app' &&
        compress &&
        req.headers['accept-encoding']?.includes(compress)
      ) {
        const encoded =
          compress === 'zstd' ? zstdCompressSync(body) : gzipSync(body);
        res
          .writeHead(200, {
            ...headers,
            'content-encoding': compress,
            'content-length': encoded.length,
          })
          .end(encoded);
        return;
      }
      res.writeHead(200, headers).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // BRAID_TSCONFIG points the bundler at a checkout's sources instead of the installed packages
  const tsconfig = process.env.BRAID_TSCONFIG;
  const { url } = await start({
    port: Number(process.env.PORT ?? 3000),
    bundles: await bundle(tsconfig ? { tsconfig } : {}),
  });
  console.log(
    `Static server (no gateway) at ${url} — open it, then ${url}billing`,
  );
}
