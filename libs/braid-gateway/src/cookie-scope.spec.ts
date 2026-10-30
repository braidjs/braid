import { describe, expect, it } from 'vitest';
import { createGateway } from './gateway.js';
import { cookieScopePrefix, scopeRequestCookies, scopeSetCookie, storagePartitionOf } from './cookie-scope.js';
import type { FragmentManifest } from './registry.js';

/**
 * Partitioned fragments' cookies. Two backends that both finish a login with `Set-Cookie: session`
 * on one origin overwrite each other, and a gateway forwarding the caller's cookies hands each
 * fragment the other's session. Cookie-jar semantics are deterministic HTTP, so this is proven with
 * requests and responses; the browser half is e2e/cookie-scope.e2e.ts.
 */

describe('scopeSetCookie()', () => {
  it('renames into the scope, makes the cookie host-only on Path=/, and keeps every other attribute', () => {
    expect(scopeSetCookie('session=x; Domain=example.com; Path=/api; HttpOnly; Secure; SameSite=Lax', 'orders')).toBe(
      'braid$orders$session=x; Path=/; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('keeps a browser-enforced prefix at the front, and deletions renamed the same way', () => {
    expect(scopeSetCookie('__Host-sid=y; Path=/; Secure', 'orders')).toBe('__Host-braid$orders$sid=y; Path=/; Secure');
    expect(scopeSetCookie('__Secure-sid=y; Secure', 'orders')).toBe('__Secure-braid$orders$sid=y; Path=/; Secure');
    expect(scopeSetCookie('session=; Max-Age=0; Path=/', 'orders')).toBe('braid$orders$session=; Path=/; Max-Age=0');
  });

  it('cannot be used to set a cookie in another scope', () => {
    expect(scopeSetCookie('braid$billing$session=stolen', 'orders')).toBe('braid$orders$braid$billing$session=stolen; Path=/');
  });

  it('drops a cookie with no name rather than guess', () => {
    expect(scopeSetCookie('=orphan; Path=/', 'orders')).toBe('');
    expect(scopeSetCookie('no-equals-sign', 'orders')).toBe('');
  });
});

describe('cookieScopePrefix()', () => {
  it('is a valid cookie-name token for any partition name, and distinct for distinct names', () => {
    const names = ['orders', 'a.b', 'a_b', 'a%b', 'a$b', 'ünï', 'with space', '(x)', 'a;b=c'];
    const prefixes = names.map(cookieScopePrefix);
    expect(new Set(prefixes).size).toBe(names.length);
    for (const prefix of prefixes) {
      // RFC 6265 cookie-name: a token, so no CTLs, whitespace or separators
      expect(prefix).toMatch(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
      // the closing `$` is the only one after the mark
      expect(prefix.slice('braid$'.length, -1)).not.toContain('$');
    }
  });
});

describe('scopeRequestCookies()', () => {
  const header = 'braid$orders$session=a; braid$billing$session=b; __Host-braid$orders$sid=c; theme=dark';

  it("sends a fragment its own cookies under its own names, and never another fragment's", () => {
    expect(scopeRequestCookies(header, 'orders', false)).toBe('session=a; __Host-sid=c');
    expect(scopeRequestCookies(header, 'billing', false)).toBe('session=b');
  });

  it("lets the fragment's own cookie win over a host cookie of the same name", () => {
    expect(scopeRequestCookies('session=host; theme=dark; braid$orders$session=own', 'orders', true)).toBe(
      'session=own; theme=dark',
    );
  });

  it('matches a __Host-/__Secure- prefix without regard to case', () => {
    expect(scopeSetCookie('__host-sid=1; Secure', 'orders')).toBe('__host-braid$orders$sid=1; Path=/; Secure');
    expect(scopeRequestCookies('__HOST-braid$orders$sid=1', 'orders', false)).toBe('__HOST-sid=1');
  });

  it("adds the host's unscoped cookies only when forwardCredentials allows", () => {
    expect(scopeRequestCookies(header, 'orders', true)).toBe('session=a; __Host-sid=c; theme=dark');
    expect(scopeRequestCookies('theme=dark', 'orders', false)).toBeNull();
    expect(scopeRequestCookies(null, 'orders', true)).toBeNull();
  });
});

describe('storagePartitionOf()', () => {
  it('reads the same grant the client does', () => {
    expect(storagePartitionOf({ id: 'orders', capabilities: { storage: 'partitioned' } })).toBe('orders');
    expect(storagePartitionOf({ id: 'orders', capabilities: { storage: { partition: 'kcd' } } })).toBe('kcd');
    expect(storagePartitionOf({ id: 'orders', capabilities: { storage: 'shared' } })).toBeNull();
    expect(storagePartitionOf({ id: 'orders' })).toBeNull();
    expect(storagePartitionOf({ id: 'orders', capabilities: { storage: 'nope' as never } })).toBeNull();
    // compat only: other adapters run in the host window, with no scoped document.cookie
    expect(storagePartitionOf({ id: 'orders', adapter: 'custom-element', capabilities: { storage: 'partitioned' } })).toBeNull();
    expect(storagePartitionOf({ id: 'orders', adapter: 'compat', capabilities: { storage: 'partitioned' } })).toBe('orders');
  });
});

describe('a gateway composing partitioned fragments', () => {
  type Seen = { cookie: string | null }[];

  /** Two partitioned fragments whose endpoints both answer `/login` with `Set-Cookie: session`. */
  function setup(options: { forwardCredentials?: boolean; storage?: FragmentManifest['capabilities'] } = {}) {
    const seen: Record<string, Seen> = { orders: [], billing: [], plain: [] };
    const fragment = (id: string, capabilities: FragmentManifest['capabilities'] = { storage: 'partitioned' }): FragmentManifest => ({
      id,
      capabilities,
      // a login that redirects; the shared fragment has no identity forwarded, so it does not
      ...(id === 'plain' ? {} : { redirect: 'navigate' as const }),
      endpoint: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        seen[id].push({ cookie: request.headers.get('cookie') });
        const path = new URL(request.url).pathname;
        const headers = new Headers({ 'content-type': 'text/html' });
        if (path === '/login') headers.append('set-cookie', `session=${id}-session; Path=/; HttpOnly`);
        if (path === '/sso') return new Response(null, { status: 302, headers: { location: '/__braid/frag/orders/landing', 'set-cookie': 'oidc_state=s1; Path=/' } });
        return new Response('<p>ok</p>', { headers });
      }) as typeof fetch,
    });
    const gateway = createGateway({
      registry: [fragment('orders', options.storage), fragment('billing'), fragment('plain', {})],
      ...(options.forwardCredentials === undefined ? {} : { forwardCredentials: options.forwardCredentials }),
    });
    const get = (path: string, cookie?: string) =>
      gateway.handle(new Request(`https://shell.example.com${path}`, { headers: cookie ? { cookie } : {} }));
    return { seen, get, gateway };
  }

  it('scopes the session cookies both logins set, so neither overwrites the other', async () => {
    const { get } = setup();
    const orders = (await get('/__braid/frag/orders/login'))!;
    const billing = (await get('/__braid/frag/billing/login'))!;

    expect(orders.headers.getSetCookie()).toEqual(['braid$orders$session=orders-session; Path=/; HttpOnly']);
    expect(billing.headers.getSetCookie()).toEqual(['braid$billing$session=billing-session; Path=/; HttpOnly']);
  });

  it("sends each fragment only its own session, back under the name it set — on the namespace and the document", async () => {
    const { get, seen } = setup();
    const jar = 'braid$orders$session=orders-session; braid$billing$session=billing-session; shell=s';

    await get('/__braid/frag/orders/api/me', jar);
    await get('/__braid/doc/billing/', jar);

    expect(seen.orders.at(-1)).toEqual({ cookie: 'session=orders-session' });
    expect(seen.billing.at(-1)).toEqual({ cookie: 'session=billing-session' });
  });

  it("adds the host's own cookies under forwardCredentials, and still never another fragment's", async () => {
    const { get, seen } = setup({ forwardCredentials: true });
    await get('/__braid/frag/orders/api/me', 'braid$orders$session=o; braid$billing$session=b; shell=s');
    expect(seen.orders.at(-1)).toEqual({ cookie: 'session=o; shell=s' });
  });

  it("leaves a shared fragment's own cookies alone, but keeps partitioned fragments' sessions from it", async () => {
    const { get, seen } = setup({ forwardCredentials: true });
    const response = (await get('/__braid/frag/plain/login', 'braid$orders$session=o; __Host-braid$orders$sid=x; shell=s'))!;
    expect(response.headers.getSetCookie()).toEqual(['session=plain-session; Path=/; HttpOnly']);
    expect(seen.plain.at(-1)).toEqual({ cookie: 'shell=s' });
  });

  it("drops Clear-Site-Data from a partitioned fragment, so its logout cannot wipe the others'", async () => {
    const gateway = createGateway({
      registry: [
        {
          id: 'orders',
          capabilities: { storage: 'partitioned' },
          endpoint: (async () => new Response('bye', { headers: { 'clear-site-data': '"cookies", "storage"' } })) as typeof fetch,
        },
      ],
    });
    const response = (await gateway.handle(new Request('https://shell.example.com/__braid/frag/orders/logout')))!;
    expect(response.headers.get('clear-site-data')).toBeNull();
  });

  it('shares cookies between fragments that name the same partition', async () => {
    const { get, seen } = setup({ storage: { storage: { partition: 'billing' } } });
    await get('/__braid/frag/orders/api/me', 'braid$billing$session=shared-login');
    expect(seen.orders.at(-1)).toEqual({ cookie: 'session=shared-login' });
  });

  it('scopes the cookies a redirecting login sets before navigating the page', async () => {
    const { get } = setup();
    const response = (await get('/__braid/doc/orders/sso'))!;
    expect(response.status).toBe(409);
    expect(response.headers.getSetCookie()).toEqual(['braid$orders$oidc_state=s1; Path=/']);
  });

  it('never coalesces two requests carrying different sessions', async () => {
    const { get, seen } = setup();
    await Promise.all([
      get('/__braid/frag/orders/api/me', 'braid$orders$session=user-1'),
      get('/__braid/frag/orders/api/me', 'braid$orders$session=user-2'),
    ]);
    expect(seen.orders.map((entry) => entry.cookie).sort()).toEqual(['session=user-1', 'session=user-2']);
  });

  it("carries the fragment's own cookies on a websocket upgrade", async () => {
    const gateway = createGateway({
      registry: [{ id: 'orders', endpoint: 'https://orders.internal', capabilities: { storage: 'partitioned' } }],
    });
    const target = await gateway.resolveUpgrade(
      new Request('https://shell.example.com/__braid/frag/orders/socket', {
        headers: { cookie: 'braid$orders$session=o; braid$billing$session=b' },
      }),
    );
    expect(target?.cookie).toBe('session=o');

    const shared = await createGateway({ registry: [{ id: 'orders', endpoint: 'https://orders.internal' }] }).resolveUpgrade(
      new Request('https://shell.example.com/__braid/frag/orders/socket'),
    );
    expect(shared && 'cookie' in shared).toBe(false);
  });
});
