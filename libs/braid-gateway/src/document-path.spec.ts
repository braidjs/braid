import { afterEach, describe, expect, it } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createGateway } from './gateway.js';
import { Registry } from './registry.js';

/**
 * `documentPath`: a single-page app on a static origin (S3 behind a CDN) has exactly one document,
 * `index.html`, and 404s every route. Without a fixed document path, a deep link asks that origin
 * for `/accounts/123` and the fragment fails on every page but the root.
 *
 * Against a real HTTP origin, so the assertions are about the requests a CDN would actually see.
 */

const BASE = '/goals-webapp';
const INDEX_HTML = `<!doctype html><html><head><script type="module" src="./main.js"></script></head><body><h1>Goals</h1></body></html>`;
const SHELL_HTML = `<html><head></head><body><fragment-slot name="goals"></fragment-slot></body></html>`;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A static origin with nothing but the app's files under its base path, and no history fallback. */
async function staticOrigin(): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.url === `${BASE}/index.html`) {
      res.writeHead(200, { 'content-type': 'text/html' }).end(INDEX_HTML);
    } else if (req.url === `${BASE}/main.js`) {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end('export {}');
    } else {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<p>NoSuchKey</p>');
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${BASE}/`, requests };
}

async function goalsGateway(documentPath?: string) {
  const origin = await staticOrigin();
  const gateway = createGateway({
    registry: [{ id: 'goals', endpoint: origin.url, pierce: ['/goals/*'], documentPath }],
  });
  return { gateway, requests: origin.requests };
}

describe('manifest documentPath', () => {
  it('fetches the fixed document for a deep link, without the route or its query', async () => {
    const { gateway, requests } = await goalsGateway('/index.html');

    const response = await gateway.handle(new Request('https://dash.example/__braid/doc/goals/accounts/123?x=1'));

    expect(response!.status).toBe(200);
    const html = await response!.text();
    expect(html).toContain('<h1>Goals</h1>');
    // prepared exactly like any other document: scripts inert, urls in the fragment's namespace
    expect(html).toContain('src="/__braid/frag/goals/main.js"');
    expect(requests).toEqual([`${BASE}/index.html`]);
  });

  it('still forwards asset requests at their own paths', async () => {
    const { gateway, requests } = await goalsGateway('/index.html');

    const response = await gateway.handle(new Request('https://dash.example/__braid/frag/goals/main.js'));

    expect(response!.status).toBe(200);
    expect(await response!.text()).toBe('export {}');
    expect(requests).toEqual([`${BASE}/main.js`]);
  });

  it('pierces a deep link with the fixed document', async () => {
    const { gateway, requests } = await goalsGateway('/index.html');

    const response = await gateway.handle(
      new Request('https://dash.example/goals/accounts/123?x=1', { headers: { 'sec-fetch-dest': 'document' } }),
      async () => new Response(SHELL_HTML, { headers: { 'content-type': 'text/html' } }),
    );

    const html = await response!.text();
    expect(html).toContain('<fragment-slot name="goals" data-braid-pierced="">');
    expect(html).toContain('<h1>Goals</h1>');
    expect(requests).toEqual([`${BASE}/index.html`]);
  });

  it('without it, a deep link is asked for at its own path (and this origin 404s it)', async () => {
    const { gateway, requests } = await goalsGateway();

    const response = await gateway.handle(new Request('https://dash.example/__braid/doc/goals/accounts/123?x=1'));

    expect(response!.status).toBe(404);
    expect(requests).toEqual([`${BASE}/accounts/123?x=1`]);
  });

  it('does not override an entry fragment, which has no document to fetch', async () => {
    const origin = await staticOrigin();
    const gateway = createGateway({
      registry: [{ id: 'goals', endpoint: origin.url, entry: '/entry.js', documentPath: '/index.html' }],
    });

    const response = await gateway.handle(new Request('https://dash.example/__braid/doc/goals/accounts/123'));

    expect(response!.status).toBe(204);
    expect(origin.requests).toEqual([]);
  });

  it('rejects a documentPath that is not a plain absolute path on the endpoint', () => {
    for (const documentPath of ['index.html', '//evil.example/x', '/.//evil.example/x', '/a/../b', '/\\evil', '/i?x', '/i#x']) {
      expect(() => new Registry([{ id: 'goals', endpoint: 'https://cdn.example/', documentPath }]), documentPath).toThrow(
        /documentPath/,
      );
    }
  });

  it('gives way to src for an unbound fragment, on both the document route and piercing', async () => {
    const origin = await staticOrigin();
    const gateway = createGateway({
      registry: [
        { id: 'goals', endpoint: origin.url, pierce: ['/goals/*'], bound: false, src: '/index.html', documentPath: '/main.js' },
      ],
    });

    // an unbound slot asks for its src through the document route
    await gateway.handle(new Request('https://dash.example/__braid/doc/goals/index.html'));
    await gateway.handle(
      new Request('https://dash.example/goals/accounts/123', { headers: { 'sec-fetch-dest': 'document' } }),
      async () => new Response(SHELL_HTML, { headers: { 'content-type': 'text/html' } }),
    );

    expect(origin.requests).toEqual([`${BASE}/index.html`, `${BASE}/index.html`]);
  });
});
