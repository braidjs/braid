import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BRAID_CLAIM_MESSAGE,
  braidGatewayHandler,
  setupBraidGateway,
} from './gateway.js';

/**
 * The in-worker gateway's decisions of its own: which requests to answer, made before `respondWith`
 * has to be called, and how a browser's navigation is handed to a gateway written for servers.
 * Everything after that is the gateway's, and is tested there.
 */

const ORIGIN = 'https://shop.example';
const SHELL =
  '<!doctype html><html><head></head><body><fragment-slot name="billing"></fragment-slot></body></html>';

const html = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/html' } });

const registry = [
  {
    id: 'billing',
    pierce: ['/billing', '/billing/*'],
    endpoint: (async () => html('<p>billed</p>')) as unknown as typeof fetch,
  },
];

/** A browser navigation. Node will not construct `mode: 'navigate'`, so it is set over a real request. */
function navigation(url: string, init: RequestInit = {}): Request {
  const request = new Request(new URL(url, ORIGIN), {
    ...init,
    headers: { accept: 'text/html', ...init.headers },
  });
  Object.defineProperty(request, 'mode', { value: 'navigate' });
  return request;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('braidGatewayHandler', () => {
  it('answers the Braid namespace from the gateway, not the network', async () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const braid = braidGatewayHandler({ registry, mode: 'production' });

    const response = await braid(
      new Request(`${ORIGIN}/__braid/realm/billing/`),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toContain('text/html');
    expect(network).not.toHaveBeenCalled();
  });

  it('pierces a navigation into the shell the network serves', async () => {
    const network = vi.fn(async () => html(SHELL));
    vi.stubGlobal('fetch', network);
    const braid = braidGatewayHandler({ registry, mode: 'production' });

    const response = await braid(navigation('/billing/invoices'));

    expect(await response?.text()).toContain('<p>billed</p>');
    expect(network).toHaveBeenCalledOnce();
  });

  it('asks the fragment as a page would: same-origin credentials, the page’s referrer policy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => html(SHELL)),
    );
    const seen: Request[] = [];
    const endpoint = (async (request: Request) => (
      seen.push(request),
      html('<p>billed</p>')
    )) as unknown as typeof fetch;
    const braid = braidGatewayHandler({
      registry: [{ ...registry[0], endpoint }],
      mode: 'production',
    });

    await (
      await braid(
        navigation('/billing', {
          credentials: 'include',
          referrerPolicy: 'no-referrer',
        }),
      )
    )?.text();

    expect(seen[0].credentials).toBe('same-origin');
    expect(seen[0].referrerPolicy).toBe('no-referrer');
  });

  it('pierces into the preloaded shell when there is one, without asking again', async () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const braid = braidGatewayHandler({ registry, mode: 'production' });

    const response = await braid(
      navigation('/billing'),
      Promise.resolve(html(SHELL)),
    );

    expect(await response?.text()).toContain('<p>billed</p>');
    expect(network).not.toHaveBeenCalled();
  });

  it('asks the network when the preload failed', async () => {
    const network = vi.fn(async () => html(SHELL));
    vi.stubGlobal('fetch', network);
    const braid = braidGatewayHandler({ registry, mode: 'production' });

    const response = await braid(
      navigation('/billing'),
      Promise.reject(new TypeError('preload failed')),
    );

    expect(await response?.text()).toContain('<p>billed</p>');
    expect(network).toHaveBeenCalledOnce();
  });

  it('hands a redirecting shell back to the browser on a route it would pierce', async () => {
    // a navigation's own fetch, when the static host answers `/billing` with `/billing/`
    const opaque = Response.error();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => opaque),
    );
    const braid = braidGatewayHandler({ registry, mode: 'production' });

    expect(await braid(navigation('/billing'))).toBe(opaque);
  });

  it('passes a navigation no fragment claims through unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => html('<p>home</p>')),
    );
    const braid = braidGatewayHandler({ registry, mode: 'production' });

    expect(await (await braid(navigation('/')))?.text()).toBe('<p>home</p>');
  });

  it('keeps the body of a navigation it forwards', async () => {
    const bodies: string[] = [];
    const endpoint = (async (request: Request) => (
      bodies.push(await request.text()),
      html('ok')
    )) as unknown as typeof fetch;
    const braid = braidGatewayHandler({
      registry: [{ ...registry[0], endpoint }],
      mode: 'production',
    });

    // a fragment form whose action lands in its own namespace
    await braid(
      navigation('/__braid/frag/billing/pay', {
        method: 'POST',
        body: 'amount=12',
      }),
    );

    expect(bodies).toEqual(['amount=12']);
  });

  it('leaves everything else to the browser, synchronously', () => {
    vi.stubGlobal('location', { origin: ORIGIN });
    const braid = braidGatewayHandler({ registry, mode: 'production' });

    // the shell's own assets, a page's own fetch for HTML (htmx, Turbo), a non-GET navigation
    // outside the namespace, and anything on another origin
    expect(braid(new Request(`${ORIGIN}/main.js`))).toBeNull();
    expect(
      braid(
        new Request(`${ORIGIN}/billing`, { headers: { accept: 'text/html' } }),
      ),
    ).toBeNull();
    expect(braid(navigation('/billing', { method: 'POST' }))).toBeNull();
    expect(
      braid(new Request('https://cdn.example/__braid/realm/billing/')),
    ).toBeNull();
    expect(braid(navigation('https://cdn.example/billing'))).toBeNull();
  });

  it.each(['/manage', '/manage/'])(
    'claims the namespace under base path %s, and only there',
    (basePath) => {
      const braid = braidGatewayHandler({
        registry,
        mode: 'production',
        basePath,
      });

      expect(
        braid(new Request(`${ORIGIN}/manage/__braid/realm/billing/`)),
      ).not.toBeNull();
      expect(braid(new Request(`${ORIGIN}/__braid/realm/billing/`))).toBeNull();
    },
  );
});

describe('setupBraidGateway', () => {
  function fakeScope() {
    const listeners = new Map<string, (event: unknown) => void>();
    const scope = {
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
      clients: { claim: vi.fn(async () => undefined) },
      registration: {
        navigationPreload: {
          enable: vi.fn(async () => undefined),
          disable: vi.fn(async () => undefined),
        },
      },
      location: { origin: ORIGIN },
    };
    for (const [key, value] of Object.entries(scope)) vi.stubGlobal(key, value);
    const dispatch = (type: string, event: unknown) =>
      listeners.get(type)?.(event);
    return { scope, dispatch };
  }

  it('answers its requests from the fetch event, and only those', async () => {
    const { dispatch } = fakeScope();
    setupBraidGateway({ registry, mode: 'production' });

    const respondWith = vi.fn();
    dispatch('fetch', {
      request: new Request(`${ORIGIN}/__braid/realm/billing/`),
      respondWith,
    });
    dispatch('fetch', {
      request: new Request(`${ORIGIN}/main.js`),
      respondWith,
    });

    expect(respondWith).toHaveBeenCalledOnce();
    expect((await respondWith.mock.calls[0][0]).status).toBe(200);
  });

  it('turns navigation preload off, and claims clients only when asked', async () => {
    // preload would send the realm frames' navigations, which the worker answers, to the server too
    const { scope, dispatch } = fakeScope();
    setupBraidGateway({ registry, mode: 'production', claimClients: true });

    const waits: Promise<unknown>[] = [];
    dispatch('activate', {
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    });
    await Promise.all(waits);

    expect(scope.registration.navigationPreload.disable).toHaveBeenCalledOnce();
    expect(scope.registration.navigationPreload.enable).not.toHaveBeenCalled();
    expect(scope.clients.claim).toHaveBeenCalledOnce();
  });

  it('claims a page that asks — one loaded past the worker — only when claiming is on', () => {
    const declining = fakeScope();
    setupBraidGateway({ registry, mode: 'production' });
    declining.dispatch('message', {
      data: { type: BRAID_CLAIM_MESSAGE },
      waitUntil: () => undefined,
    });
    expect(declining.scope.clients.claim).not.toHaveBeenCalled();

    const claiming = fakeScope();
    setupBraidGateway({ registry, mode: 'production', claimClients: true });
    claiming.dispatch('message', {
      data: { type: BRAID_CLAIM_MESSAGE },
      waitUntil: () => undefined,
    });
    expect(claiming.scope.clients.claim).toHaveBeenCalledOnce();
  });

  it('keeps fragment assets in their partition, fetched through the in-worker gateway', async () => {
    const { dispatch } = fakeScope();
    const put = vi.fn(async () => undefined);
    const caches = {
      open: vi.fn(async () => ({ put, match: async () => undefined })),
    } as unknown as CacheStorage;
    const asset = (async () =>
      new Response('export {}', {
        headers: { 'content-type': 'text/javascript' },
      })) as unknown as typeof fetch;
    setupBraidGateway({
      registry: [{ id: 'billing', endpoint: asset }],
      mode: 'production',
      assets: { caches },
    });

    const respondWith = vi.fn();
    dispatch('fetch', {
      request: new Request(`${ORIGIN}/__braid/frag/billing/main.js`),
      respondWith,
    });
    const response = await respondWith.mock.calls[0][0];

    expect(await response.text()).toBe('export {}');
    expect(caches.open).toHaveBeenCalledWith('braid-frag:billing');
    expect(put).toHaveBeenCalledOnce();
  });

  it('never routes another origin’s namespace through the gateway, assets cache included', () => {
    const { dispatch } = fakeScope();
    setupBraidGateway({
      registry,
      mode: 'production',
      assets: { caches: { open: vi.fn() } as unknown as CacheStorage },
    });

    const respondWith = vi.fn();
    dispatch('fetch', {
      request: new Request('https://cdn.example/__braid/frag/billing/main.js'),
      respondWith,
    });

    expect(respondWith).not.toHaveBeenCalled();
  });

  it('refuses assets under a base path, where the cache would recognise nothing', () => {
    fakeScope();
    expect(() =>
      setupBraidGateway({
        registry,
        mode: 'production',
        basePath: '/manage',
        assets: {},
      }),
    ).toThrow(/basePath/);
  });
});
