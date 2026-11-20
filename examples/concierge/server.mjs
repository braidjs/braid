import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from './build.mjs';

/**
 * The Concierge server, over a built folder.
 *
 *   GET  /                 the app; the trip screen prerendered for the renderer asking
 *   GET  /agent/stream     the agent's surface, projected for the renderer asking
 *   POST /agent/actions    what a renderer sends back; answered with more messages
 *   GET  /agent/log        what has been received (for the example's own tests)
 *   GET  /gallery.html     an empty page with the app's styles, for drawing any A2UI surface
 *
 * The renderer asking is the one its `A2UI-Renderer-Capabilities` header names, or, for a link a
 * person can open, `?renderer=legacy`: the page as an old build of the web app sees it.
 */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};
const HEADERS = { 'x-content-type-options': 'nosniff' };

export async function start({ dir, port = 0 } = {}) {
  const root = normalize(dir);
  const lib = await import(pathToFileURL(join(root, 'server/lib.mjs')).href);
  const index = JSON.parse(
    await readFile(join(root, 'prerendered/index.json'), 'utf8'),
  );
  const template = await readFile(join(root, 'public/index.html'), 'utf8');
  const received = [];

  const server = createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return void res.writeHead(400).end();
    }
    const send = (status, type, body) =>
      res.writeHead(status, { ...HEADERS, 'content-type': type }).end(body);
    const renderer = lib.rendererOf(
      req.headers['a2ui-renderer-capabilities'],
      url.searchParams.get('renderer'),
    );

    if (url.pathname === '/' && req.method === 'GET') {
      if (renderer.status !== 'ok')
        return send(409, 'text/plain', `unknown renderer: ${renderer.status}`);
      const context =
        url.searchParams.get('sale') === '1' ? 'summer-sale' : undefined;
      const variant = lib.selectPrerendered(
        index,
        'trip',
        [renderer.catalogId],
        context,
      );
      const trip = variant?.html
        ? await readFile(join(root, 'prerendered', variant.html), 'utf8')
        : '<p>This trip cannot be shown in this version of the app.</p>';
      const page = template
        .replace('<!--trip-->', () => trip) // a function: `$&` in the markup is markup, not a pattern
        .replaceAll('__CATALOG_ID__', renderer.catalogId)
        .replace(
          '__RENDERER__',
          url.searchParams.get('renderer') === 'legacy' ? 'legacy' : 'current',
        );
      return send(200, TYPES['.html'], page);
    }
    if (url.pathname === '/agent/stream' && req.method === 'GET') {
      if (renderer.status !== 'ok')
        return send(409, 'application/json', JSON.stringify(renderer));
      return send(
        200,
        'application/jsonl; charset=utf-8',
        lib.agentStream(renderer),
      );
    }
    if (url.pathname === '/agent/actions' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1_000_000)
          return send(413, 'text/plain', 'too large');
      }
      let envelope;
      try {
        envelope = JSON.parse(body);
      } catch {
        return send(400, 'text/plain', 'not JSON');
      }
      received.push(envelope);
      return send(
        200,
        'application/jsonl; charset=utf-8',
        lib.answer(envelope),
      );
    }
    if (url.pathname === '/agent/log' && req.method === 'GET')
      return send(200, 'application/json', JSON.stringify(received));

    const file = normalize(join(root, 'public', url.pathname));
    if (!file.startsWith(join(root, 'public') + sep))
      return send(404, 'text/plain', 'not found');
    try {
      return send(
        200,
        TYPES[extname(file)] ?? 'application/octet-stream',
        await readFile(file),
      );
    } catch {
      return send(404, 'text/plain', 'not found');
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = await build({
    ...(process.env.BRAID_TSCONFIG
      ? { tsconfig: process.env.BRAID_TSCONFIG }
      : {}),
  });
  const { url } = await start({ dir, port: Number(process.env.PORT ?? 3919) });
  console.log(
    `Concierge on ${url}  (the page as an old build sees it: ${url}?renderer=legacy)`,
  );
}
