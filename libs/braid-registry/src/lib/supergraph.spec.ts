import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FragmentManifest } from '@braidlabs/gateway';
import { subgraph, supergraph } from './supergraph.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('subgraph()', () => {
  it("routes every team fragment through the team gateway's raw fragment namespace", async () => {
    const source = subgraph({
      name: 'orders',
      url: 'https://orders.internal/team/',
      registry: [
        { id: 'orders', endpoint: 'http://10.0.3.17:4200', pierce: ['/orders', '/orders/*'] },
        { id: 'order-nav', endpoint: (async () => new Response('')) as unknown as typeof fetch, bound: false, src: '/nav' },
      ],
    });

    const manifests = await source();

    expect(manifests.map((manifest) => manifest.endpoint)).toEqual([
      'https://orders.internal/team/__braid/frag/orders/',
      'https://orders.internal/team/__braid/frag/order-nav/',
    ]);
    // everything but the endpoint is the team's to say
    expect(manifests[0].pierce).toEqual(['/orders', '/orders/*']);
    expect(manifests[1]).toMatchObject({ bound: false, src: '/nav' });
  });

  it("loads the team's manifests from a URL, as a gateway would", async () => {
    const fetchMock = vi.fn(async () => Response.json([{ id: 'orders', endpoint: 'http://orders:4200' }]));
    vi.stubGlobal('fetch', fetchMock);

    const manifests = await subgraph({
      name: 'orders',
      url: 'https://orders.internal',
      registry: 'https://orders.internal/braid-registry.json',
    })();

    expect(fetchMock).toHaveBeenCalledWith('https://orders.internal/braid-registry.json', expect.anything());
    expect(manifests[0].endpoint).toBe('https://orders.internal/__braid/frag/orders/');
  });

  it('names the subgraph when its registry cannot be loaded', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 503 }));

    await expect(
      subgraph({ name: 'orders', url: 'https://orders.internal', registry: 'https://orders.internal/r.json' })(),
    ).rejects.toThrow(/subgraph "orders".*HTTP 503/);
  });

  it('refuses a url that is not an absolute http(s) URL', () => {
    expect(() => subgraph({ name: 'orders', url: '/orders', registry: [] })).toThrow(/absolute http/);
  });

  it('gives up on a registry URL that does not answer, naming the subgraph', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    );

    await expect(
      subgraph({ name: 'orders', url: 'https://orders.internal', registry: 'https://orders.internal/r.json', timeoutMs: 20 })(),
    ).rejects.toThrow(/subgraph "orders".*failed/);
  });

  it('refuses a registry that is not an array of manifests', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ manifests: [] }));

    await expect(
      subgraph({ name: 'orders', url: 'https://orders.internal', registry: 'https://orders.internal/r.json' })(),
    ).rejects.toThrow(/subgraph "orders" is not an array/);
  });
});

describe('subgraph() limits on what a team registry can declare', () => {
  const team = (manifest: Partial<FragmentManifest>, options: Partial<Parameters<typeof subgraph>[0]> = {}) =>
    subgraph({
      name: 'orders',
      url: 'https://orders.internal',
      registry: [{ id: 'orders', endpoint: 'x:', ...manifest }],
      ...options,
    })();

  it("drops the team's own capability grants and serves the org's instead", async () => {
    const declared = { context: { read: ['user'] }, permissions: ['camera'], sharedGlobals: ['dataLayer'] };

    const [ungranted] = await team({ capabilities: declared });
    const [granted] = await team({ capabilities: declared }, { capabilities: { orders: { context: { read: ['cart'] } } } });

    expect(ungranted.capabilities).toBeUndefined();
    expect(granted.capabilities).toEqual({ context: { read: ['cart'] } });
  });

  it('keeps pierce patterns inside the routes the org gave the subgraph', async () => {
    await expect(team({ pierce: ['/orders', '/orders/*'] }, { routes: ['/orders/'] })).resolves.toHaveLength(1);
    await expect(team({ pierce: ['/orders/*', '/login'] }, { routes: ['/orders'] })).rejects.toThrow(
      /fragment "orders" pierces "\/login", outside its routes \(\/orders\)/,
    );
    // a prefix is a path segment, not a string prefix
    await expect(team({ pierce: ['/orders-admin'] }, { routes: ['/orders'] })).rejects.toThrow(/outside its routes/);
  });

  it('refuses a claim on the whole site when the org declared no routes', async () => {
    for (const pattern of ['/', '/*', '/:page', '/(.*)']) {
      await expect(team({ pierce: [pattern] })).rejects.toThrow(/claims the whole site/);
    }
    await expect(team({ pierce: ['/orders/*'] })).resolves.toHaveLength(1);
  });

  it('requires entry to be a path on the endpoint, so module code comes through the org gateway', async () => {
    await expect(team({ entry: '/main.js' })).resolves.toHaveLength(1);
    for (const entry of ['https://cdn.example/main.js', '//cdn.example/main.js', 'data:text/javascript,1']) {
      await expect(team({ entry })).rejects.toThrow(/absolute entry/);
    }
  });
});

describe('supergraph()', () => {
  const org: FragmentManifest[] = [{ id: 'home', endpoint: 'https://home.internal', pierce: ['/'] }];

  it("composes the org's own fragments and every subgraph's into one registry", async () => {
    const manifests = await supergraph([
      org,
      subgraph({ name: 'orders', url: 'https://orders.internal', registry: [{ id: 'orders', endpoint: 'x:', pierce: ['/orders/*'] }] }),
    ])();

    expect(manifests.map((manifest) => [manifest.id, manifest.endpoint])).toEqual([
      ['home', 'https://home.internal'],
      ['orders', 'https://orders.internal/__braid/frag/orders/'],
    ]);
  });

  it('fails closed on a fragment id two subgraphs both claim, naming both', async () => {
    const compose = supergraph([
      subgraph({ name: 'orders', url: 'https://orders.internal', registry: [{ id: 'cart', endpoint: 'x:' }] }),
      subgraph({ name: 'checkout', url: 'https://checkout.internal', registry: [{ id: 'cart', endpoint: 'x:' }] }),
    ]);

    await expect(compose()).rejects.toThrow(/"cart".*subgraph "orders".*subgraph "checkout"/);
  });

  it("names the org's own source by position when it is part of a collision", async () => {
    const compose = supergraph([
      org,
      subgraph({ name: 'orders', url: 'https://orders.internal', registry: [{ id: 'home', endpoint: 'x:' }] }),
    ]);

    await expect(compose()).rejects.toThrow(/"home".*source #0.*subgraph "orders"/);
  });

  it('reports overlapping routes across subgraphs as a warning, not a failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const manifests = await supergraph([
      subgraph({ name: 'orders', url: 'https://orders.internal', registry: [{ id: 'orders', endpoint: 'x:', pierce: ['/shop/*'] }] }),
      subgraph({ name: 'catalog', url: 'https://catalog.internal', registry: [{ id: 'catalog', endpoint: 'x:', pierce: ['/shop/*'] }] }),
    ])();

    expect(manifests).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pierce-overlap'));
  });

  it('shares one composition between concurrent callers, and retries after a failure', async () => {
    let calls = 0;
    let fail = true;
    const source = subgraph({
      name: 'orders',
      url: 'https://orders.internal',
      registry: async () => {
        calls++;
        if (fail) throw new Error('registry down');
        return [{ id: 'orders', endpoint: 'x:' }];
      },
    });
    const compose = supergraph([source]);

    await expect(Promise.all([compose(), compose()])).rejects.toThrow('registry down');
    expect(calls).toBe(1);

    fail = false;
    const [first, second] = await Promise.all([compose(), compose()]);
    expect(first).toBe(second);
    expect(calls).toBe(2);
  });

  it('fails closed on any other composition error', async () => {
    const compose = supergraph([[{ id: 'orders/v2', endpoint: 'https://orders.internal' }]]);

    await expect(compose()).rejects.toThrow(/composition failed:\n {2}invalid-id/);
  });
});
