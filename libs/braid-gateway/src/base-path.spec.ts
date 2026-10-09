import { describe, expect, it } from 'vitest';
import { createGateway, type GatewayOptions } from './gateway.js';

/**
 * `basePath`: a host mounted under a path on a domain it shares (`/manage/` behind an ALB) does
 * not own the root `/__braid/*` namespaces, so the gateway serves and emits them under its mount.
 */

const FRAGMENT_HTML =
  `<!doctype html><html><head><link rel="stylesheet" href="./app.css">` +
  `<script type="module" src="/main.js"></script></head>` +
  `<body><img srcset="/a.png 1x, /b.png 2x"><h1>Goals</h1></body></html>`;
const SHELL_HTML = `<html><head></head><body><fragment-slot name="goals"></fragment-slot></body></html>`;

const endpoint = (async (request: Request) => {
  const { pathname } = new URL(request.url);
  return pathname.endsWith('.js')
    ? new Response(`// ${pathname}`, { headers: { 'content-type': 'text/javascript' } })
    : new Response(FRAGMENT_HTML, { headers: { 'content-type': 'text/html' } });
}) as unknown as typeof fetch;

function gateway(options: Partial<GatewayOptions> = {}) {
  return createGateway({
    registry: [
      { id: 'goals', endpoint, pierce: ['/manage/goals/*'] },
      { id: 'rating', endpoint: 'https://widgets.example', entry: '/star.js', adapter: 'custom-element' },
    ],
    ...options,
  });
}

const shell = async () => new Response(SHELL_HTML, { headers: { 'content-type': 'text/html' } });

describe('gateway basePath', () => {
  const managed = gateway({ basePath: '/manage' });

  it('serves the realm stub under the mount, with a <base> into the mounted fragment namespace', async () => {
    const response = await managed.handle(new Request('https://x.example/manage/__braid/realm/goals/manage/goals/1'));

    expect(response!.status).toBe(200);
    expect(await response!.text()).toContain('<base href="/manage/__braid/frag/goals/manage/goals/1">');
  });

  it('re-roots a document’s subresources into the mounted namespace', async () => {
    const response = await managed.handle(new Request('https://x.example/manage/__braid/doc/goals/manage/goals/1'));
    const html = await response!.text();

    expect(html).toContain('href="/manage/__braid/frag/goals/app.css"');
    expect(html).toContain('src="/manage/__braid/frag/goals/main.js"');
    expect(html).toContain('srcset="/manage/__braid/frag/goals/a.png 1x, /manage/__braid/frag/goals/b.png 2x"');
    expect(html).not.toMatch(/"\/__braid\//);
  });

  it('pierces with the same mounted urls', async () => {
    const response = await managed.handle(
      new Request('https://x.example/manage/goals/1', { headers: { 'sec-fetch-dest': 'document' } }),
      shell,
    );
    const html = await response!.text();

    expect(html).toContain('<h1>Goals</h1>');
    expect(html).toContain('src="/manage/__braid/frag/goals/main.js"');
  });

  it('forwards mounted asset requests with the mount and namespace stripped', async () => {
    const response = await managed.handle(new Request('https://x.example/manage/__braid/frag/goals/main.js'));

    expect(await response!.text()).toBe('// /main.js');
  });

  it('mounts the entry module it stamps onto the stub', async () => {
    const response = await managed.handle(new Request('https://x.example/manage/__braid/realm/rating/'));

    expect(await response!.text()).toContain('/manage/__braid/frag/rating/star.js');
  });

  it('resolves websocket upgrades under the mount', async () => {
    const upgrade = await managed.resolveUpgrade(new Request('https://x.example/manage/__braid/frag/rating/live'));

    expect(upgrade?.target.href).toBe('https://widgets.example/live');
  });

  it('leaves the root namespace to the shell', async () => {
    expect(await managed.handle(new Request('https://x.example/__braid/frag/goals/main.js'))).toBeNull();
    expect(await managed.resolveUpgrade(new Request('https://x.example/__braid/frag/rating/live'))).toBeNull();
    // and a path that merely starts with the same characters is not under the mount
    expect(await managed.handle(new Request('https://x.example/manager/__braid/frag/goals/main.js'))).toBeNull();
  });

  it('treats "", "/" and a trailing slash as the same as no basePath / the trimmed path', async () => {
    const stub = async (options: Partial<GatewayOptions>, path = '/__braid/realm/goals/x') =>
      (await gateway(options).handle(new Request(`https://x.example${path}`)))!.text();

    const plain = await stub({});
    expect(await stub({ basePath: '' })).toBe(plain);
    expect(await stub({ basePath: '/' })).toBe(plain);
    expect(await stub({ basePath: '/manage/' }, '/manage/__braid/realm/goals/x')).toBe(
      await stub({ basePath: '/manage' }, '/manage/__braid/realm/goals/x'),
    );
  });

  it('rejects a basePath that is not an absolute path', () => {
    expect(() => gateway({ basePath: 'manage' })).toThrow(/basePath/);
    expect(() => gateway({ basePath: '/manage?x' })).toThrow(/basePath/);
  });

  it('refuses the features that do not support a basePath yet, rather than serving them at the root', () => {
    expect(() => gateway({ basePath: '/manage', serviceWorker: true })).toThrow(/serviceWorker/);
    expect(() => gateway({ basePath: '/manage', discovery: {} })).toThrow(/discovery/);
    expect(() => gateway({ basePath: '/manage', telemetry: { on: () => undefined, webVitals: true } })).toThrow(
      /webVitals/,
    );
  });
});
