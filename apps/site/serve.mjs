// A dependency-free static file server for the built site, for local preview only.
//
//   node apps/site/serve.mjs --dir dist/apps/site --port 4600 [--prefix /braid-site/]
//
// `--prefix` serves the site from a sub-path, to check that every URL in it is relative.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const root = resolve(arg('dir', 'dist/apps/site'));
const port = Number(arg('port', '4600'));
const prefix = `/${arg('prefix', '/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** Maps a request path to a file under `root`, or null when it falls outside it. */
function fileFor(urlPath) {
  if (!urlPath.startsWith(prefix)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.slice(prefix.length));
  } catch {
    return null;
  }
  const candidate = resolve(root, `.${sep}${decoded}`);
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  try {
    const stat = statSync(candidate);
    if (stat.isDirectory()) {
      const index = join(candidate, 'index.html');
      return statSync(index).isFile() ? index : null;
    }
    return stat.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  // A directory URL without its trailing slash would resolve relative links one level too high.
  if (!pathname.endsWith('/') && !extname(pathname) && fileFor(`${pathname}/`)) {
    res.writeHead(301, { location: `${pathname}/` }).end();
    return;
  }
  const file = fileFor(pathname);
  if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(file ? 405 : 404, { 'content-type': 'text/plain; charset=utf-8' }).end(file ? 'Method not allowed' : 'Not found');
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`site: http://localhost:${port}${prefix} → ${root}`);
});
