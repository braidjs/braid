// A dependency-free static file server for the built site, for local preview only.
//
//   node apps/site/serve.mjs --dir dist/apps/site --port 4600 [--prefix /braid-site/] [--host 127.0.0.1]
//
// `--prefix` serves the site from a sub-path, to check that every URL in it is relative. It listens
// on 127.0.0.1 unless `--host` says otherwise, since it is a preview server, not a host.
// `--api <module.mjs>` also answers /api/contact with that module's `handle(request)` (see dev.mjs).
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { pipeline, Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const root = realpathSync(resolve(arg('dir', 'dist/apps/site')));
const port = Number(arg('port', '4600'));
const host = arg('host', '127.0.0.1');
const prefix = `/${arg('prefix', '/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
const apiModule = arg('api', undefined);
const api = apiModule ? (await import(pathToFileURL(resolve(apiModule)).href)).handle : null;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** True when `path` is `root` or inside it. */
const inside = (path) => {
  const rel = relative(root, path);
  return !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
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
  if (!inside(candidate)) return null;
  try {
    // Resolve symlinks too: a link inside the root must not serve a file outside it.
    let real = realpathSync(candidate);
    if (statSync(real).isDirectory()) real = realpathSync(join(real, 'index.html'));
    return inside(real) && statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

const send = (res, status, text) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(text);

/** Hands one request to the --api module as a standard Request, and writes its Response back. */
async function answerApi(req, res) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
  // The local stand-in for the edge's client-IP header; set here, so a client can't choose it.
  headers.set('x-dev-client-ip', req.socket.remoteAddress ?? '127.0.0.1');
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: 'half',
  });
  const response = await api(request);
  const out = {};
  response.headers.forEach((value, key) => (out[key] = value));
  res.writeHead(response.status, out).end(Buffer.from(await response.arrayBuffer()));
}

createServer((req, res) => {
  let pathname;
  try {
    ({ pathname } = new URL(req.url ?? '/', 'http://localhost'));
  } catch {
    send(res, 400, 'Bad request');
    return;
  }
  // Only ever answer clean paths: an empty segment or a backslash is how a redirect gets turned into
  // `//other-site` (an open redirect), and no file of ours lives at such a path anyway.
  if (pathname.includes('//') || pathname.includes('\\') || posix.normalize(pathname) !== pathname) {
    send(res, 404, 'Not found');
    return;
  }
  if (api && pathname === `${prefix}api/contact`) {
    answerApi(req, res).catch((error) => {
      console.error('api:', error);
      send(res, 500, 'Server error');
    });
    return;
  }
  // A directory URL without its trailing slash would resolve relative links one level too high.
  if (!pathname.endsWith('/') && !extname(pathname) && fileFor(`${pathname}/`)) {
    res.writeHead(301, { location: `${pathname}/` }).end();
    return;
  }
  const file = fileFor(pathname);
  if (!file) {
    send(res, 404, 'Not found');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed');
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  if (req.method === 'HEAD') res.end();
  // A file that vanishes or turns unreadable after the stat ends this response, not the server.
  else pipeline(createReadStream(file), res, (error) => error && res.destroy());
}).listen(port, host, () => {
  console.log(`site: http://${host}:${port}${prefix} → ${root}`);
});
