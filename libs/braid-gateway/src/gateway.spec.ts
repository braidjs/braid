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

describe('redirect: navigate', () => {
  const documentUrl = 'https://example.com/__braid/doc/billing/invoices?page=2';

  /** A gateway whose fragment endpoint answers every request with `upstream`. */
  function gatewayAnswering(
    upstream: () => Response,
    manifest: Record<string, unknown> = { redirect: 'navigate' },
    options: Record<string, unknown> = {},
  ) {
    const endpoint = vi.fn(async () => upstream());
    return {
      endpoint,
      gateway: createGateway({
        registry: [{ id: 'billing', endpoint: endpoint as unknown as typeof fetch, ...manifest }],
        additionalHeaders: { 'x-identity': 'signed' },
        ...options,
      }),
    };
  }

  const redirectTo = (location: string, init: ResponseInit = {}) => () =>
    new Response(null, { status: 302, ...init, headers: { location, ...(init.headers as Record<string, string>) } });

  it('answers a fragment document redirect with a 409 carrying the target, never a 3xx', async () => {
    const { gateway } = gatewayAnswering(redirectTo('/login?next=%2Fx', { headers: { etag: '"a"', vary: 'cookie' } }));

    const response = (await gateway.handle(new Request(documentUrl)))!;

    expect(response.status).toBe(409);
    expect(response.headers.get('x-braid-redirect-location')).toBe('/login?next=%2Fx');
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-braid-fragment-id')).toBe('billing');
    // nothing of the upstream redirect's own representation leaks through
    expect(response.headers.get('etag')).toBeNull();
    expect(response.headers.get('vary')).toBeNull();
  });

  it('keeps the cookies the redirect set, which a login needs when the user comes back', async () => {
    const upstream = () => {
      const response = new Response(null, { status: 302, headers: { location: '/login' } });
      response.headers.append('set-cookie', 'oidc_state=abc; Path=/; HttpOnly');
      response.headers.append('set-cookie', 'oidc_nonce=def; Path=/; HttpOnly');
      return response;
    };
    const { gateway } = gatewayAnswering(upstream);

    const response = (await gateway.handle(new Request(documentUrl)))!;

    expect(response.headers.getSetCookie()).toEqual(['oidc_state=abc; Path=/; HttpOnly', 'oidc_nonce=def; Path=/; HttpOnly']);
  });

  it('allows an origin listed in redirectOrigins and refuses everything else with a 502', async () => {
    const listed = gatewayAnswering(redirectTo('https://sso.vendor.com/authorize?x=1'), undefined, {
      redirectOrigins: ['https://*.vendor.com'],
    });
    expect((await listed.gateway.handle(new Request(documentUrl)))!.headers.get('x-braid-redirect-location')).toBe(
      'https://sso.vendor.com/authorize?x=1',
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (const location of ['javascript:alert(1)', 'data:text/html,x', 'https://evil.net/x?token=secret']) {
        const { gateway } = gatewayAnswering(redirectTo(location), undefined, { mode: 'production' });
        const response = (await gateway.handle(new Request(documentUrl)))!;

        expect(response.status).toBe(502);
        expect(response.headers.get('x-braid-redirect-location')).toBeNull();
        expect(await response.text()).not.toContain('secret');
      }
      expect(warn.mock.calls.flat().join(' ')).not.toContain('secret');
    } finally {
      warn.mockRestore();
    }
  });

  it('points a login return URL at the page the client says it is on', async () => {
    const { gateway } = gatewayAnswering(
      redirectTo('/login?next=https%3A%2F%2Fexample.com%2Finvoices%3Fpage%3D2'),
    );

    const response = (await gateway.handle(
      new Request(documentUrl, { headers: { 'x-braid-return-url': 'https://example.com/billing/invoices?tab=open' } }),
    ))!;

    const target = new URL(response.headers.get('x-braid-redirect-location')!, 'https://example.com');
    expect(target.pathname).toBe('/login');
    expect(target.searchParams.get('next')).toBe('https://example.com/billing/invoices?tab=open');
  });

  it('leaves everything else exactly as it was', async () => {
    // not opted in: the redirect passes through untouched
    const plain = gatewayAnswering(redirectTo('/login'), {});
    const passed = (await plain.gateway.handle(new Request(documentUrl)))!;
    expect(passed.status).toBe(302);
    expect(passed.headers.get('location')).toBe('/login');

    // opted in, but only the document namespace is rewritten: assets keep their redirects
    const opted = gatewayAnswering(redirectTo('/cdn/app.js'));
    const asset = (await opted.gateway.handle(new Request('https://example.com/__braid/frag/billing/app.js')))!;
    expect(asset.status).toBe(302);
    expect(asset.headers.get('location')).toBe('/cdn/app.js');

    // a 304 is not a redirect
    const notModified = gatewayAnswering(() => new Response(null, { status: 304 }));
    expect((await notModified.gateway.handle(new Request(documentUrl)))!.status).toBe(304);
  });

  it('strips an x-braid-redirect-location a fragment tries to send itself', async () => {
    const forged = () => new Response('<p>hi</p>', { status: 200, headers: { 'content-type': 'text/html', 'x-braid-redirect-location': 'https://evil.net' } });

    for (const manifest of [{}, { redirect: 'navigate' }]) {
      const { gateway } = gatewayAnswering(forged, manifest);
      const response = (await gateway.handle(new Request(documentUrl)))!;
      expect(response.status).toBe(200);
      expect(response.headers.get('x-braid-redirect-location')).toBeNull();
    }
  });

  it('warns once when a fragment opts in but nothing carries the user identity to it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      createGateway({ registry: [{ id: 'a', endpoint: 'https://a.internal', redirect: 'navigate' }] });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('forwardCredentials'));

      warn.mockClear();
      createGateway({ registry: [{ id: 'a', endpoint: 'https://a.internal', redirect: 'navigate' }], forwardCredentials: true });
      createGateway({ registry: [{ id: 'a', endpoint: 'https://a.internal' }] });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects an unknown redirect mode and a malformed redirectOrigins at construction', () => {
    expect(() => createGateway({ registry: [{ id: 'a', endpoint: 'https://a.internal', redirect: 'follow' as never }] })).toThrow(/redirect/);
    expect(() => createGateway({ registry: [], redirectOrigins: ['not-an-origin'] })).toThrow(/redirectOrigins/);
  });

  it('does not forward the page the user is on to the fragment endpoint, which could hold a token in its hash', async () => {
    const { gateway, endpoint } = gatewayAnswering(() => new Response('ok'));

    await gateway.handle(
      new Request(documentUrl, { headers: { 'x-braid-return-url': 'https://example.com/cb#access_token=TOK' } }),
    );

    expect((endpoint.mock.calls[0] as unknown as [Request])[0].headers.get('x-braid-return-url')).toBeNull();
  });

  it('never shares one login redirect, and the cookies carrying its state, between two callers', async () => {
    let calls = 0;
    const upstream = () => {
      calls += 1;
      const response = new Response(null, { status: 302, headers: { location: '/login' } });
      response.headers.append('set-cookie', `oidc_state=${calls}; Path=/`);
      return response;
    };
    const { gateway } = gatewayAnswering(upstream);

    const [a, b] = await Promise.all([gateway.handle(new Request(documentUrl)), gateway.handle(new Request(documentUrl))]);

    expect(calls).toBe(2);
    expect(a!.headers.getSetCookie()).not.toEqual(b!.headers.getSetCookie());
  });

  it('is not held up by another request sharing a fetch that never reads its body', async () => {
    // a tee branch's cancel() only settles when its sibling does — so nothing here may wait on it
    const { gateway } = gatewayAnswering(redirectTo('/login'));

    const [redirect] = await Promise.all([
      gateway.handle(new Request(documentUrl)),
      gateway.handle(new Request('https://example.com/__braid/frag/billing/x')),
    ]);

    expect(redirect!.status).toBe(409);
  });

  it('strips a forged header on the fragment namespace too, and warns on first use for a loader registry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const endpoint = vi.fn(
        async () => new Response('x', { headers: { 'x-braid-redirect-location': 'https://evil.net' } }),
      );
      const gateway = createGateway({
        registry: async () => [{ id: 'billing', endpoint: endpoint as unknown as typeof fetch, redirect: 'navigate' as const }],
      });

      const asset = (await gateway.handle(new Request('https://example.com/__braid/frag/billing/app.js')))!;
      expect(asset.headers.get('x-braid-redirect-location')).toBeNull();

      // a loader registry cannot be inspected at construction, so the warning waits for a redirect
      expect(warn).not.toHaveBeenCalled();
      const redirecting = createGateway({
        registry: async () => [{ id: 'billing', endpoint: (async () => new Response(null, { status: 302, headers: { location: '/login' } })) as unknown as typeof fetch, redirect: 'navigate' as const }],
      });
      await redirecting.handle(new Request(documentUrl));
      await redirecting.handle(new Request(documentUrl));
      expect(warn.mock.calls.filter(([message]) => String(message).includes('forwardCredentials'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
