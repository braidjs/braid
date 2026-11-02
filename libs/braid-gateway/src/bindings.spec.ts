import { afterEach, describe, expect, it } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createGateway, toFetchHandler } from './gateway.js';
import { toNodeMiddleware } from './node.js';

/**
 * Integration tests for the framework bindings, against the real frameworks.
 *
 * Piercing is the demanding case: it requires the gateway to *read* the shell application's
 * response, which each framework exposes differently. These tests assert the full path — a
 * fragment server-rendered into the shell's markup — not just that the middleware is callable.
 */

const FRAGMENT_HTML = `<!doctype html><html><head><title>Billing</title></head><body><h1>Invoices</h1><script>go()</script></body></html>`;
const SHELL_HTML = `<html><head><title>Shell</title></head><body><h1>Shell</h1><fragment-slot name="billing"></fragment-slot></body></html>`;

function makeGateway() {
  return createGateway({
    registry: [
      {
        id: 'billing',
        pierce: ['/billing', '/billing/*'],
        endpoint: (async () =>
          new Response(FRAGMENT_HTML, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch,
      },
    ],
  });
}

/** Asserts a composed document really contains the server-rendered fragment. */
function expectPierced(html: string) {
  expect(html).toContain('<fragment-slot name="billing" data-braid-pierced="">');
  expect(html).toContain('<template shadowrootmode="open">');
  expect(html).toContain('<h1>Invoices</h1>');
  expect(html).toContain('<script type="inert">go()</script>');
  // the shell's own markup survives around it
  expect(html).toContain('<h1>Shell</h1>');
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const documentInit = { headers: { 'sec-fetch-dest': 'document' } };

describe('Express', () => {
  it('pierces a document response and passes other routes through', async () => {
    const { default: express } = await import('express');

    const app = express();
    app.use(toNodeMiddleware(makeGateway()));
    app.get('/billing/invoices', (_req, res) => res.type('html').send(SHELL_HTML));
    app.get('/other', (_req, res) => res.type('html').send('<html><body>other</body></html>'));

    const origin = await listen(createServer(app));

    expectPierced(await (await fetch(`${origin}/billing/invoices`, documentInit)).text());
    expect(await (await fetch(`${origin}/other`, documentInit)).text()).toContain('other');
  });

  it('serves realm stubs through the namespace', async () => {
    const { default: express } = await import('express');

    const app = express();
    app.use(toNodeMiddleware(makeGateway()));
    app.use((_req, res) => res.status(404).send('shell 404'));

    const origin = await listen(createServer(app));
    const response = await fetch(`${origin}/__braid/realm/billing/`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('name="braid-protocol"');
  });

  it('leaves a streaming shell streaming', async () => {
    const { default: express } = await import('express');

    const app = express();
    app.use(toNodeMiddleware(makeGateway()));
    app.get('/billing/stream', (_req, res) => {
      res.type('html');
      res.write('<html><body><h1>Shell</h1>');
      res.write('<fragment-slot name="billing"></fragment-slot>');
      res.end('</body></html>');
    });

    const origin = await listen(createServer(app));
    expectPierced(await (await fetch(`${origin}/billing/stream`, documentInit)).text());
  });

  it('correctly handles downstream 304 Not Modified and 204 No Content responses', async () => {
    const { default: express } = await import('express');

    const app = express();
    app.use(toNodeMiddleware(makeGateway()));
    app.get('/not-modified', (_req, res) => res.status(304).end());
    app.get('/no-content', (_req, res) => res.status(204).end());

    const origin = await listen(createServer(app));

    const res304 = await fetch(`${origin}/not-modified`);
    expect(res304.status).toBe(304);

    const res204 = await fetch(`${origin}/no-content`);
    expect(res204.status).toBe(204);
  });
});

describe('NestJS', () => {
  it('pierces a document response through the Express adapter', async () => {
    const { NestFactory } = await import('@nestjs/core');
    const { Module, Controller, Get, Header } = await import('@nestjs/common');

    @Controller()
    class ShellController {
      @Get('billing/invoices')
      @Header('content-type', 'text/html')
      shell() {
        return SHELL_HTML;
      }
    }

    @Module({ controllers: [ShellController] })
    class AppModule {}

    const app = await NestFactory.create(AppModule, { logger: false });
    app.use(toNodeMiddleware(makeGateway()));
    await app.init();

    const origin = await listen(createServer(app.getHttpAdapter().getInstance()));

    try {
      expectPierced(await (await fetch(`${origin}/billing/invoices`, documentInit)).text());
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe('h3 / Nitro', () => {
  it('pierces through toFetchHandler wrapping the app web handler', async () => {
    const { createApp, defineEventHandler, toWebHandler } = await import('h3');

    const app = createApp();
    app.use(
      defineEventHandler(
        () => new Response(SHELL_HTML, { headers: { 'content-type': 'text/html' } }),
      ),
    );

    const handler = toFetchHandler(makeGateway(), toWebHandler(app));
    const response = await handler(new Request('http://localhost/billing/invoices', documentInit));

    expectPierced(await response.text());
  });

  it('serves namespace requests through the same handler', async () => {
    const { createApp, defineEventHandler, toWebHandler } = await import('h3');

    const app = createApp();
    app.use(defineEventHandler(() => new Response('shell', { status: 404 })));

    const handler = toFetchHandler(makeGateway(), toWebHandler(app));
    const response = await handler(
      new Request('http://localhost/__braid/frag/billing/app.js', { headers: { 'sec-fetch-dest': 'script' } }),
    );

    expect(response.headers.get('x-braid-fragment-id')).toBe('billing');
  });

  it('runs the shell app at most once per request', async () => {
    const { createApp, defineEventHandler, toWebHandler } = await import('h3');

    let shellRuns = 0;
    const app = createApp();
    app.use(
      defineEventHandler(() => {
        shellRuns++;
        return new Response(SHELL_HTML, { headers: { 'content-type': 'text/html' } });
      }),
    );

    const handler = toFetchHandler(makeGateway(), toWebHandler(app));
    await handler(new Request('http://localhost/billing/invoices', documentInit)).then((r) => r.text());
    expect(shellRuns).toBe(1);

    // and on a route braid does not touch
    await handler(new Request('http://localhost/unrelated', documentInit)).then((r) => r.text());
    expect(shellRuns).toBe(2);
  });
});

describe('Node response framing', () => {
  it('drops the endpoint\'s hop-by-hop headers, and any its connection header names', async () => {
    const gateway = createGateway({
      registry: [
        {
          id: 'billing',
          endpoint: (async () =>
            new Response('x', {
              headers: { 'content-type': 'text/javascript', 'transfer-encoding': 'identity', connection: 'keep-alive, x-hop', 'x-hop': '1', 'keep-alive': 'timeout=5' },
            })) as unknown as typeof fetch,
        },
      ],
    });
    const response = await gateway.handle(new Request('http://localhost/__braid/frag/billing/a.js'), async () => new Response(null, { status: 404 }));

    for (const name of ['transfer-encoding', 'connection', 'keep-alive', 'x-hop']) expect(response!.headers.has(name)).toBe(false);
    expect(response!.headers.get('content-type')).toBe('text/javascript');
    expect(await response!.text()).toBe('x');
  });

  /**
   * `fetch` decodes a compressed upstream body but keeps the upstream's `content-encoding` and
   * `content-length`. Forwarded unchanged, Node writes the decoded bytes after a header promising
   * fewer, and the surplus lands at the head of the next response on the same keep-alive socket.
   */
  it('asks a URL endpoint only for codings every fetch decodes, whatever the browser accepts', async () => {
    let asked: string | undefined;
    const upstream = await listen(
      createServer((req, res) => {
        asked = req.headers['accept-encoding'];
        res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': '2' }).end('ok');
      }),
    );
    const gateway = createGateway({ registry: [{ id: 'billing', endpoint: upstream }] });
    const response = await gateway.handle(
      new Request('http://localhost/__braid/frag/billing/a.js', { headers: { 'accept-encoding': 'gzip, deflate, br, zstd' } }),
      async () => new Response(null, { status: 404 }),
    );

    expect(asked).toBe('gzip, x-gzip, deflate, br');
    expect(await response!.text()).toBe('ok');
    expect(response!.headers.get('content-length')).toBe('2');
  });

  it('never writes past a declared length, so an endpoint cannot answer the next request on the connection', async () => {
    const { connect } = await import('node:net');
    const gateway = createGateway({
      registry: [
        {
          id: 'billing',
          // what a function endpoint wrapping fetch forwards from a compressed upstream, made hostile
          endpoint: (async () =>
            new Response('ok' + 'HTTP/1.1 200 OK\r\ncontent-length: 8\r\n\r\nINJECTED', {
              headers: { 'content-type': 'text/javascript', 'content-length': '2' },
            })) as unknown as typeof fetch,
        },
      ],
    });
    const origin = await listen(
      createServer((req, res) => toNodeMiddleware(gateway)(req, res, () => res.writeHead(200, { 'content-length': '5' }).end('shell'))),
    );
    const { hostname, port } = new URL(origin);

    // two requests pipelined on one connection: whatever follows the first response is read as the second
    const received = await new Promise<string>((resolve) => {
      const socket = connect(Number(port), hostname, () => {
        socket.write(`GET /__braid/frag/billing/a.js HTTP/1.1\r\nhost: x\r\n\r\nGET /other HTTP/1.1\r\nhost: x\r\n\r\n`);
      });
      let data = '';
      socket.on('data', (chunk) => (data += chunk));
      socket.on('close', () => resolve(data));
      socket.on('error', () => undefined);
    });

    expect(received).not.toContain('INJECTED');
  });

  it('refuses a response in a coding it did not ask for, which fetch may or may not have decoded', async () => {
    const { zstdCompressSync } = await import('node:zlib');
    const script = 'x'.repeat(4096);
    const compressed = zstdCompressSync(script);
    const upstream = await listen(
      createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/javascript', 'content-encoding': 'zstd', 'content-length': compressed.length });
        res.end(compressed);
      }),
    );
    const gateway = createGateway({ registry: [{ id: 'billing', endpoint: upstream }] });
    const response = await gateway.handle(new Request('http://localhost/__braid/frag/billing/a.js'), async () => new Response(null, { status: 404 }));

    // never a body labelled with a coding it is not in, whichever way this runtime's fetch went
    expect(response!.status).toBe(502);
    expect(response!.headers.has('content-encoding')).toBe(false);
    expect(await response!.text()).toContain('"zstd"');
  });

  it('answers HEAD for a forwarded asset that declares its length', async () => {
    const { request } = await import('node:http');
    const upstream = await listen(createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': '2' }).end('ok')));
    const gateway = createGateway({ registry: [{ id: 'billing', endpoint: upstream }] });
    const origin = await listen(createServer((req, res) => toNodeMiddleware(gateway)(req, res, () => res.writeHead(404).end())));

    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${origin}/__braid/frag/billing/a.js`, { method: 'HEAD' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
  });

  it('forwards a compressed upstream body with headers that describe it, and keeps the socket usable', async () => {
    const { gzipSync } = await import('node:zlib');
    const { Agent, get } = await import('node:http');

    const script = `console.log(${JSON.stringify('x'.repeat(4096))});`;
    const compressed = gzipSync(script);
    const upstream = await listen(
      createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/javascript', 'content-encoding': 'gzip', 'content-length': compressed.length });
        res.end(compressed);
      }),
    );
    const gateway = createGateway({ registry: [{ id: 'billing', endpoint: upstream }] });
    const origin = await listen(createServer((req, res) => toNodeMiddleware(gateway)(req, res, () => res.writeHead(404).end())));

    // one socket for both requests, so the second can only succeed if the first left it clean
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const fetchOnAgent = (path: string) =>
      new Promise<{ headers: Record<string, unknown>; body: string; reused: boolean }>((resolve, reject) => {
        const req = get(`${origin}${path}`, { agent, headers: { 'accept-encoding': 'gzip', 'sec-fetch-dest': 'script' } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks).toString(), reused: req.reusedSocket }));
          res.on('error', reject);
        });
        req.on('error', reject);
      });

    try {
      const first = await fetchOnAgent('/__braid/frag/billing/main.js');
      expect(first.headers['content-encoding']).toBeUndefined();
      expect(first.body).toBe(script);

      const second = await fetchOnAgent('/__braid/frag/billing/other.js');
      expect(second.reused).toBe(true);
      expect(second.body).toBe(script);
    } finally {
      agent.destroy();
    }
  });
});
