import { afterEach, describe, expect, it, vi } from 'vitest';
import { braidFetchHandler } from './asset-handler.js';
import { braidGatewayHandler, setupBraidGateway } from './gateway.js';
import { addStaticRoutes, patternLiteral, staticRoutesFor, type StaticRoute } from './static-routes.js';
import { setupBraidWorker } from './worker.js';

/**
 * Install-time routes have one job: send the browser to the worker for exactly what the worker's
 * listener answers. A route that disagrees with the listener either bypasses the worker for a
 * request it owns (a broken page) or wakes it for one it does not (today's cost, no worse).
 */

const ORIGIN = 'https://shop.example';

/** Which source the browser would pick for a request, as it evaluates the rules: first match wins. */
function routeOf(rules: readonly StaticRoute[], request: Request): StaticRoute['source'] | undefined {
  for (const rule of rules) {
    const { urlPattern, requestMethod, requestMode } = rule.condition;
    if (urlPattern && !(urlPattern as { test(url: string): boolean }).test(request.url)) continue;
    if (requestMethod && request.method !== requestMethod) continue;
    if (requestMode && request.mode !== requestMode) continue;
    return rule.source;
  }
  return undefined;
}

/** A browser navigation; Node will not construct `mode: 'navigate'`, so it is set over a real request. */
function navigation(url: string, method = 'GET'): Request {
  const request = new Request(new URL(url, ORIGIN), { method, headers: { accept: 'text/html' } });
  Object.defineProperty(request, 'mode', { value: 'navigate' });
  return request;
}

const sample = (): Request[] => [
  new Request(`${ORIGIN}/__braid/realm/billing/`),
  new Request(`${ORIGIN}/__braid/frag/billing/main.js?v=2`),
  new Request(`${ORIGIN}/__braid/doc/billing/invoices`),
  new Request(`${ORIGIN}/__braid/frag/billing/pay`, { method: 'POST', body: 'x' }),
  new Request(`${ORIGIN}/manage/__braid/realm/billing/`),
  new Request(`${ORIGIN}/main.js`),
  new Request(`${ORIGIN}/api/orders`, { method: 'POST', body: '{}' }),
  new Request(`${ORIGIN}/billing`, { headers: { accept: 'text/html' } }),
  new Request('https://cdn.example/__braid/frag/billing/main.js'),
  navigation('/billing/invoices'),
  navigation('/'),
  navigation('/billing', 'POST'),
  navigation('https://cdn.example/billing'),
];

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The rules a worker registers at install, captured from its install listener as the browser would see them. */
function registeredRules(setup: () => void): StaticRoute[] | undefined {
  const listeners = new Map<string, (event: unknown) => void>();
  vi.stubGlobal('addEventListener', (type: string, listener: (event: unknown) => void) => listeners.set(type, listener));
  setup();
  let rules: StaticRoute[] | undefined;
  listeners.get('install')?.({
    addRoutes: async (registered: StaticRoute[]) => {
      rules = registered;
    },
    waitUntil: () => undefined,
  });
  return rules;
}

/** Cache storage that holds nothing, and a network that answers everything: enough to ask a handler whether it claims. */
const quiet = {
  caches: { open: async () => ({ match: async () => undefined, put: async () => undefined }), keys: async () => [] } as unknown as CacheStorage,
  fetch: (async () => new Response('')) as unknown as typeof fetch,
};

describe('the gateway worker’s routes', () => {
  it.each([undefined, '/manage', '/manage/'])('are what its handler claims (base path %s)', (basePath) => {
    vi.stubGlobal('location', { origin: ORIGIN });
    const braid = braidGatewayHandler({ registry: [], mode: 'production', basePath });
    const rules = registeredRules(() => setupBraidGateway({ registry: [], mode: 'production', basePath }))!;

    for (const request of sample()) {
      expect(routeOf(rules, request), `${request.method} ${request.url} (${request.mode})`).toBe(
        braid.claims(request) ? 'fetch-event' : 'network',
      );
    }
  });

  it('are registered at install, and the install waits for them', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    vi.stubGlobal('addEventListener', (type: string, listener: (event: unknown) => void) => listeners.set(type, listener));
    vi.stubGlobal('location', { origin: ORIGIN });
    setupBraidGateway({ registry: [], mode: 'production' });

    const addRoutes = vi.fn(async () => undefined);
    const waits: Promise<unknown>[] = [];
    listeners.get('install')?.({ addRoutes, waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    await Promise.all(waits);

    expect(addRoutes).toHaveBeenCalledOnce();
    expect(waits).toHaveLength(1);
    const rules = (addRoutes.mock.calls[0] as unknown as [StaticRoute[]])[0];
    expect(rules.at(-1)?.source).toBe('network');
  });

  it('are left out when the worker shares its file with other fetch listeners', () => {
    const listeners = new Map<string, (event: unknown) => void>();
    vi.stubGlobal('addEventListener', (type: string, listener: (event: unknown) => void) => listeners.set(type, listener));
    vi.stubGlobal('location', { origin: ORIGIN });
    setupBraidGateway({ registry: [], mode: 'production', staticRoutes: false });

    expect(listeners.has('install')).toBe(false);
  });
});

describe('the asset worker’s routes', () => {
  it('are what its listener claims', () => {
    const answers = braidFetchHandler(quiet);
    const rules = registeredRules(() => setupBraidWorker({ ...quiet, staticRoutes: true }))!;

    for (const request of sample()) {
      expect(routeOf(rules, request), `${request.method} ${request.url} (${request.mode})`).toBe(
        answers(request) ? 'fetch-event' : 'network',
      );
    }
  });

  it('are left out with offline composition, which also answers fetches for HTML no route can single out', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rules = registeredRules(() => setupBraidWorker({ ...quiet, staticRoutes: true, offline: { snapshotUrl: '/snapshot.json' } }));

    expect(rules).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('offline'));
    warn.mockRestore();
  });

  it('are registered only when asked for', () => {
    const run = (staticRoutes: boolean | undefined) => {
      const listeners = new Map<string, (event: unknown) => void>();
      vi.stubGlobal('addEventListener', (type: string, listener: (event: unknown) => void) => listeners.set(type, listener));
      setupBraidWorker(staticRoutes === undefined ? {} : { staticRoutes });
      const addRoutes = vi.fn(async () => undefined);
      listeners.get('install')?.({ addRoutes, waitUntil: () => undefined });
      return addRoutes;
    };

    expect(run(undefined)).not.toHaveBeenCalled();
    expect(run(false)).not.toHaveBeenCalled();
    expect(run(true)).toHaveBeenCalledOnce();
  });
});

describe('addStaticRoutes', () => {
  it('does nothing where the browser has no static routing', () => {
    expect(addStaticRoutes({}, { pathnames: ['/__braid/*'], navigations: true })).toBeUndefined();
  });

  it('turns a refusal into a warning, so the install still succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const refused = addStaticRoutes(
      { addRoutes: async () => Promise.reject(new TypeError('unsupported condition')) },
      { pathnames: ['/__braid/*'], navigations: true },
    );

    await expect(refused).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('keeps an IPv6 origin as an address, not pattern syntax', () => {
    const rules = staticRoutesFor({ pathnames: ['/__braid/*'], origin: 'http://[::1]:4200', navigations: true })!;
    const visit = (url: string) => {
      const request = new Request(url);
      Object.defineProperty(request, 'mode', { value: 'navigate' });
      return request;
    };

    expect(routeOf(rules, visit('http://[::1]:4200/a/b?x'))).toBe('fetch-event');
    expect(routeOf(rules, visit('http://[::2]:4200/a/b'))).toBe('network');
  });

  it('turns rules it cannot build into the same warning as a refusal', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const addRoutes = vi.fn(async () => undefined);

    expect(addStaticRoutes({ addRoutes }, { pathnames: ['/(unclosed'], navigations: false })).toBeUndefined();
    expect(addRoutes).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('matches a base path as written, not as pattern syntax', () => {
    const rules = staticRoutesFor({ pathnames: [`${patternLiteral('/a(b)*')}/__braid/*`], origin: ORIGIN, navigations: false })!;
    expect(routeOf(rules, new Request(`${ORIGIN}/a(b)*/__braid/x`))).toBe('fetch-event');
    expect(routeOf(rules, new Request(`${ORIGIN}/abbb/__braid/x`))).toBe('network');
  });
});
