import { describe, expect, it, vi } from 'vitest';
import { createGateway, resolveEndpointUrl, toWebMiddleware } from './gateway.js';
import { BRAID_ADAPTER_META, BRAID_PROTOCOL_META, BRAID_PROTOCOL_VERSION } from './protocol.js';

const registry = [
  { id: 'legacy-billing', endpoint: 'https://billing.internal' },
  { id: 'checkout', endpoint: 'https://checkout.internal', adapter: 'react' },
];

function gatewayFetch(request: Request) {
  return createGateway({ registry }).handle(request);
}

describe('gateway namespace routing', () => {
  it('ignores requests outside the fragment namespace', async () => {
    expect(await gatewayFetch(new Request('https://example.com/'))).toBeNull();
    expect(await gatewayFetch(new Request('https://example.com/checkout'))).toBeNull();
    expect(await gatewayFetch(new Request('https://example.com/__braid/other'))).toBeNull();
  });

  it('404s unknown fragment ids without protocol meta (so the client fails loudly, never the app shell)', async () => {
    const response = await gatewayFetch(new Request('https://example.com/__braid/frag/nope/'));

    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);
    const body = await response!.text();
    expect(body).toContain('unknown fragment');
    expect(body).not.toContain(BRAID_PROTOCOL_META);
  });

  it('serves the realm stub from its own namespace, carrying protocol version, adapter, and <base>', async () => {
    const response = await gatewayFetch(
      new Request('https://example.com/__braid/realm/legacy-billing/invoices?page=2'),
    );

    expect(response!.status).toBe(200);
    const body = await response!.text();
    expect(body).toContain(`<meta name="${BRAID_PROTOCOL_META}" content="${BRAID_PROTOCOL_VERSION}">`);
    expect(body).toContain(`<meta name="${BRAID_ADAPTER_META}" content="compat">`);
    // the base points at the *fragment* namespace, so the realm's relative urls fetch assets
    expect(body).toContain('<base href="/__braid/frag/legacy-billing/invoices">');
  });

  it('stamps the manifest-declared adapter onto the stub when one is declared', async () => {
    const response = await gatewayFetch(new Request('https://example.com/__braid/realm/checkout/'));

    expect(await response!.text()).toContain(`<meta name="${BRAID_ADAPTER_META}" content="react">`);
  });

  it('forwards namespace requests to the endpoint with the prefix stripped', async () => {
    const endpointFetch = vi.fn(async (request: Request) => {
      return new Response(`echo:${new URL(request.url).pathname}`, { status: 200 });
    });

    const gateway = createGateway({
      registry: [{ id: 'billing', endpoint: endpointFetch as unknown as typeof fetch }],
    });

    const response = await gateway.handle(
      new Request('https://example.com/__braid/frag/billing/assets/app.js?v=3'),
    );

    expect(await response!.text()).toBe('echo:/assets/app.js');
    const forwardedRequest = endpointFetch.mock.calls[0][0];
    expect(new URL(forwardedRequest.url).search).toBe('?v=3');
    expect(forwardedRequest.headers.get('sec-fetch-dest')).toBe('empty');
    expect(forwardedRequest.headers.get('x-braid-fragment-mode')).toBe('embedded');
    expect(response!.headers.get('x-braid-fragment-id')).toBe('billing');
  });

  it('serves braid URLs with no request-header variance at all', async () => {
    // Stubs, documents and assets have their own paths, so nothing in a braid namespace depends
    // on a request header — these URLs cache on URL alone, on any CDN, with no configuration.
    const stub = await gatewayFetch(new Request('https://example.com/__braid/realm/legacy-billing/'));
    const asset = await gatewayFetch(new Request('https://example.com/__braid/frag/legacy-billing/app.js'));
    const unknown = await gatewayFetch(new Request('https://example.com/__braid/frag/nope/'));

    for (const response of [stub, asset, unknown]) {
      expect(response!.headers.get('vary')).toBeNull();
    }
  });

  it('serves the same body for a braid URL however it is requested', async () => {
    const plain = await gatewayFetch(new Request('https://example.com/__braid/realm/legacy-billing/'));
    const asIframe = await gatewayFetch(
      new Request('https://example.com/__braid/realm/legacy-billing/', {
        headers: { 'sec-fetch-dest': 'iframe' },
      }),
    );

    expect(await plain!.text()).toBe(await asIframe!.text());
  });

  it('overwrites client-supplied forwarded headers', async () => {
    const endpointFetch = vi.fn(async () => new Response('ok'));
    const gateway = createGateway({
      registry: [{ id: 'billing', endpoint: endpointFetch as unknown as typeof fetch }],
    });

    await gateway.handle(
      new Request('https://example.com/__braid/frag/billing/', {
        headers: { 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'gopher' },
      }),
    );

    // a fragment building absolute urls from these must not build them for the attacker
    const forwarded = endpointFetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get('x-forwarded-host')).toBe('example.com');
    expect(forwarded.headers.get('x-forwarded-proto')).toBe('https');
  });

  it('passes forwarded headers through when a trusted proxy is declared', async () => {
    const endpointFetch = vi.fn(async () => new Response('ok'));
    const gateway = createGateway({
      registry: [{ id: 'billing', endpoint: endpointFetch as unknown as typeof fetch }],
      trustForwardedHeaders: true,
    });

    await gateway.handle(
      new Request('https://example.com/__braid/frag/billing/', {
        headers: { 'x-forwarded-host': 'public.example' },
      }),
    );

    expect((endpointFetch.mock.calls[0][0] as Request).headers.get('x-forwarded-host')).toBe('public.example');
  });

  describe('endpoint scope', () => {
    it("keeps forwarded requests inside the endpoint's declared path", async () => {
      const requested: string[] = [];
      const gateway = createGateway({
        registry: [{ id: 'billing', endpoint: 'https://internal.example/apps/billing/' }],
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: Request) => {
        requested.push(new URL(input.url).href);
        return new Response('ok');
      }) as unknown as typeof fetch;

      try {
        await gateway.handle(new Request('https://example.com/__braid/frag/billing/assets/app.js'));
      } finally {
        globalThis.fetch = originalFetch;
      }

      // not https://internal.example/assets/app.js — the manifest's path is a boundary
      expect(requested).toEqual(['https://internal.example/apps/billing/assets/app.js']);
    });

    it('drops out of the namespace entirely when a request encodes dot segments', async () => {
      const gateway = createGateway({
        registry: [{ id: 'billing', endpoint: 'https://internal.example/apps/billing/' }],
      });

      // the URL parser normalizes %2e%2e when the request is constructed, so this never looks
      // like a namespace request in the first place — it goes to the shell, not to a fragment
      const request = new Request('https://example.com/__braid/frag/billing/%2e%2e/%2e%2e/admin');
      expect(new URL(request.url).pathname).toBe('/__braid/admin');
      expect(await gateway.handle(request)).toBeNull();
    });

    it('refuses to resolve a path outside the endpoint (defense in depth)', () => {
      // unreachable through the public path today, since the platform normalizes first; this
      // pins the guard so it survives a runtime that normalizes differently
      expect(() =>
        resolveEndpointUrl(
          'https://internal.example/apps/billing/',
          new URL('https://example.com/../../admin'),
          'billing',
        ),
      ).not.toThrow();

      const escaping = new URL('https://example.com/');
      Object.defineProperty(escaping, 'pathname', { value: '/%2e%2e/admin' });
      expect(() => resolveEndpointUrl('https://internal.example/apps/billing/', escaping, 'billing')).toThrow(
        /outside its endpoint path/,
      );
    });

    it("never leaves the endpoint's origin for a path that starts with //", async () => {
      // `//host/x` is a protocol-relative URL to a parser: joined onto a pathless endpoint as a
      // string, it would name another host entirely (169.254.169.254 being the classic one)
      const escaping = new URL('https://example.com/');
      escaping.pathname = '//169.254.169.254/latest';

      expect(resolveEndpointUrl('https://internal.example/', escaping, 'billing').href).toBe(
        'https://internal.example//169.254.169.254/latest',
      );

      // the upgrade path assigns the pathname as-is, so it is where this was reachable
      const gateway = createGateway({ registry: [{ id: 'billing', endpoint: 'https://internal.example/' }] });
      const upgrade = await gateway.resolveUpgrade(
        new Request('https://example.com/__braid/frag/billing//169.254.169.254/latest'),
      );
      expect(upgrade?.target.origin).toBe('https://internal.example');
    });
  });

  it('turns an exceeded timeout budget into a named 504', async () => {
    const gateway = createGateway({
      registry: [
        {
          id: 'slow',
          timeoutMs: 10,
          endpoint: ((_request: Request, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            })) as unknown as typeof fetch,
        },
      ],
    });

    const response = await gateway.handle(new Request('https://example.com/__braid/frag/slow/'));

    expect(response!.status).toBe(504);
    expect(await response!.text()).toContain('timeout budget');
  });
});

describe('toWebMiddleware()', () => {
  it('passes non-braid requests through to the shell', async () => {
    const middleware = toWebMiddleware(createGateway({ registry }));
    const next = vi.fn(async () => new Response('shell'));

    const response = await middleware(new Request('https://example.com/some/page'), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe('shell');
  });

  it('handles braid requests without calling the shell', async () => {
    const middleware = toWebMiddleware(createGateway({ registry }));
    const next = vi.fn(async () => new Response('shell'));

    const response = await middleware(new Request('https://example.com/__braid/frag/nope/'), next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
  });
});
