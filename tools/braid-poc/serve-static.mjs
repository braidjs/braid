/**
 * Serves a built fragment — the stand-in for however that team actually deploys.
 *
 * Each fragment gets its own origin and knows nothing about Braid; the gateway forwards
 * `/__braid/frag/<id>/*` here with the prefix stripped, so this server sees exactly the paths it
 * would serve if you opened it directly.
 *
 *   node tools/braid-poc/serve-static.mjs <dist-dir> <port> [--spa] [--cors]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const [dir, port, ...flags] = process.argv.slice(2);
if (!dir || !port) {
  console.error('usage: serve-static.mjs <dist-dir> <port> [--spa] [--cors]');
  process.exit(1);
}

const ROOT = resolve(process.cwd(), dir);
const SPA = flags.includes('--spa');
/**
 * `--cors` is for the contract fragment, and only for it.
 *
 * Every other fragment here is proxied through the gateway, so the browser sees it as same-origin
 * and no CORS is involved. A contract fragment has no gateway route by design — the client imports
 * its entry module straight from this origin into a `blob:` realm — and a cross-origin module import
 * needs the header. That the flag is needed *only* here is the clearest single sign of how different
 * the two paths are.
 */
const CORS = flags.includes('--cors');

const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const filePath = normalize(join(ROOT, pathname));

  if (!filePath.startsWith(ROOT)) {
    res.statusCode = 403;
    return res.end('forbidden');
  }

  try {
    const body = await readFile(filePath);
    res.setHeader('content-type', MIME[extname(filePath)] ?? 'application/octet-stream');
    if (CORS) res.setHeader('access-control-allow-origin', '*');
    // unhashed filenames in a demo: never let a browser hold a stale copy
    res.setHeader('cache-control', 'no-store');
    res.end(body);
  } catch {
    if (!SPA) {
      res.statusCode = 404;
      return res.end('not found');
    }
    try {
      // history fallback: any unknown path is a client route, so serve the app shell
      const index = await readFile(join(ROOT, 'index.html'));
      res.setHeader('content-type', MIME['.html']);
      res.setHeader('cache-control', 'no-store');
      res.end(index);
    } catch {
      res.statusCode = 404;
      res.end(`not built — run: npx nx build for ${dir}`);
    }
  }
}).listen(Number(port), () => console.log(`serving ${dir} on http://localhost:${port}`));
