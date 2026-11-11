import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';

/**
 * A plain static server for the built desk — no gateway, no Braid. It stands in for whatever
 * static host the folder is deployed to. Every /__braid/ URL the page uses is answered by the
 * service worker; if one ever reaches this server, it is a 404 and is logged.
 */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

/**
 * Serves `dir` at `base` (a path ending in `/`). `onRequest` sees every path asked for, and
 * `headers` are added to every response, as a host's own security headers would be.
 */
export async function start({ dir, port = 0, base = '/starport/', onRequest, headers = {} }) {
  const root = normalize(dir);
  const server = createServer(async (req, res) => {
    // a request-target such as `//` is not a URL, and any page can make a browser send one here
    let pathname;
    try {
      ({ pathname } = new URL(req.url, 'http://localhost'));
    } catch {
      return void res.writeHead(400).end();
    }
    onRequest?.(pathname);
    if (pathname.includes('/__braid/')) {
      console.warn(`static server: ${pathname} reached the network — the worker is not in control`);
      return void res.writeHead(404, headers).end();
    }
    if (!pathname.startsWith(base)) {
      return void res.writeHead(pathname === '/' ? 302 : 404, pathname === '/' ? { location: base } : {}).end();
    }
    const file = pathname.slice(base.length);
    // a folder is its index.html, as on any static host
    const resolved = normalize(join(root, extname(file) ? file : join(file, 'index.html')));
    if (!resolved.startsWith(root + sep)) return void res.writeHead(404).end();
    try {
      const body = await readFile(resolved);
      res
        .writeHead(200, {
          'content-type': TYPES[extname(resolved)] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
          ...headers,
        })
        .end(body);
    } catch {
      res.writeHead(404, headers).end();
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}${base}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // BRAID_TSCONFIG points at a checkout's tsconfig.base.json, to build from source
  const tsconfig = process.env.BRAID_TSCONFIG;
  const dir = await build(tsconfig ? { tsconfig } : {});
  const { url } = await start({ dir, port: Number(process.env.PORT ?? 3000) });
  console.log(`Starport is open at ${url}`);
}
