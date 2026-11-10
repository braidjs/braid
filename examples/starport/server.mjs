import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

/**
 * Starport: one desk, five independently "deployed" apps. The server is a Braid gateway in front
 * of static files — the shell at /, each app under /apps/{id}/ — and nothing else. The gateway
 * serves the apps to the page as fragments, and their FDC3 App Directory from the registry below.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const SHIP = ['starport.ship'];

/** The registry: what each app is, and which intents it can take. This is all the desk knows of them. */
export const registry = (origin) => [
  {
    id: 'flights',
    title: 'Flights',
    endpoint: `${origin}/apps/flights/`,
    fdc3: { raises: { PlotRoute: SHIP, HailShip: SHIP }, userChannels: { broadcasts: SHIP } },
  },
  {
    id: 'star-map',
    title: 'Star Map',
    endpoint: `${origin}/apps/star-map/`,
    fdc3: { listensFor: { PlotRoute: { contexts: SHIP } }, userChannels: { listensFor: SHIP } },
  },
  {
    id: 'radar',
    title: 'Radar',
    endpoint: `${origin}/apps/radar/`,
    fdc3: { listensFor: { PlotRoute: { contexts: SHIP } }, userChannels: { listensFor: SHIP } },
  },
  {
    id: 'cargo',
    title: 'Cargo',
    endpoint: `${origin}/apps/cargo/`,
    fdc3: { userChannels: { listensFor: SHIP } },
  },
  {
    id: 'comms',
    title: 'Comms',
    endpoint: `${origin}/apps/comms/`,
    fdc3: { listensFor: { HailShip: { contexts: SHIP } } },
  },
];

const bundleOptions = (tsconfig) => ({
  bundle: true,
  format: 'esm',
  target: 'es2022',
  logLevel: 'silent',
  // relative to where the server was started, as the path was given
  ...(tsconfig ? { tsconfig: resolve(tsconfig) } : {}),
});

/** Bundles the desk's runtime. `tsconfig` lets a Braid checkout resolve the packages from source. */
export async function bundle({ tsconfig } = {}) {
  const result = await build({
    ...bundleOptions(tsconfig),
    entryPoints: [join(here, 'src', 'main.js')],
    platform: 'browser',
    write: false,
  });
  return { '/main.js': result.outputFiles[0].text };
}

/** `@braidlabs/gateway`: the installed package, or with `tsconfig`, a checkout's sources. */
export async function loadGateway({ tsconfig } = {}) {
  if (!tsconfig) {
    const [{ createGateway }, { toNodeMiddleware }] = await Promise.all([import('@braidlabs/gateway'), import('@braidlabs/gateway/node')]);
    return { createGateway, toNodeMiddleware };
  }
  const dir = await mkdtemp(join(tmpdir(), 'starport-'));
  try {
    const out = join(dir, 'gateway.mjs');
    await build({
      ...bundleOptions(tsconfig),
      stdin: {
        contents: `export { createGateway } from '@braidlabs/gateway';\nexport { toNodeMiddleware } from '@braidlabs/gateway/node';\n`,
        resolveDir: here,
      },
      platform: 'node',
      outfile: out,
    });
    return await import(pathToFileURL(out).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function serveStatic(pathname, res) {
  // /apps/{id}/… is that app's own files; everything else is the shell's
  const file = pathname.startsWith('/apps/') ? pathname.slice(1) : join('shell', pathname);
  const resolved = normalize(join(here, 'public', extname(file) ? file : join(file, 'index.html')));
  if (!resolved.startsWith(join(here, 'public') + sep)) return res.writeHead(404).end();
  try {
    const body = await readFile(resolved);
    res
      .writeHead(200, {
        'content-type': TYPES[extname(resolved)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        // the desk may be framed by nothing but itself
        ...(pathname.startsWith('/apps/') ? {} : { 'x-frame-options': 'SAMEORIGIN' }),
      })
      .end(body);
  } catch {
    res.writeHead(404).end();
  }
}

/** Starts the desk. `bundles` and `gateway` default to the installed packages. */
export async function start({ port = 0, bundles, gateway } = {}) {
  const scripts = bundles ?? (await bundle());
  const { createGateway, toNodeMiddleware } = gateway ?? (await loadGateway());
  // listening first: the registry names the apps by this server's own address
  const server = createServer();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const middleware = toNodeMiddleware(
    createGateway({
      // A local example: the apps are on loopback, over http.
      mode: 'development',
      registry: registry(origin),
      // the apps' FDC3 records, at /__braid/registry/appd/v2/apps
      discovery: { appd: true },
    }),
  );
  server.on('request', (req, res) => {
    // a request-target such as `//` is not a URL, and any page can make a browser send one here
    let pathname;
    try {
      ({ pathname } = new URL(req.url, 'http://localhost'));
    } catch {
      return void res.writeHead(400).end();
    }
    if (scripts[pathname]) {
      res
        .writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
        .end(scripts[pathname]);
      return;
    }
    // the apps' own files are fetched by the gateway, as from any other deployment
    if (pathname.startsWith('/apps/')) return void serveStatic(pathname, res);
    middleware(req, res, () => void serveStatic(pathname, res));
  });
  return { url: `${origin}/`, close: () => new Promise((resolve) => server.close(resolve)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // BRAID_TSCONFIG points at a checkout's tsconfig.base.json, to run from source
  const tsconfig = process.env.BRAID_TSCONFIG;
  const options = tsconfig ? { tsconfig } : {};
  const { url } = await start({
    port: Number(process.env.PORT ?? 3000),
    bundles: await bundle(options),
    gateway: await loadGateway(options),
  });
  console.log(`Starport is open at ${url}`);
}
