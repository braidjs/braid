import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createGateway, toFetchHandler, type GatewayOptions } from './gateway.js';
import { toNodeMiddleware } from './node.js';
import type { FragmentManifest } from './registry.js';
import { speculationRulesFor } from './speculation.js';

/**
 * Speculation Rules from the registry: the pages a fragment pierces, offered to the browser to
 * fetch or render before a click — for the fragments that asked, and only to callers who may load
 * them.
 */

const ORIGIN = 'https://shop.example';
const RULES = `${ORIGIN}/__braid/speculation-rules.json`;

const fragmentEndpoint = (async () =>
  new Response('<p>fragment</p>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;

const shell = (body = '<!doctype html><html><head></head><body><fragment-slot name="billing"></fragment-slot></body></html>') =>
  async () => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

const page = (path: string) => new Request(`${ORIGIN}${path}`, { headers: { 'sec-fetch-dest': 'document', accept: 'text/html' } });

function gateway(registry: Partial<FragmentManifest>[], options: Partial<GatewayOptions> = {}) {
  return createGateway({
    registry: registry.map((manifest) => ({ endpoint: fragmentEndpoint, ...manifest }) as FragmentManifest),
    mode: 'production',
    speculationRules: true,
    ...options,
  });
}

const billing: Partial<FragmentManifest> = { id: 'billing', pierce: ['/billing', '/billing/*'], speculate: 'prerender' };

describe('the Speculation-Rules header', () => {
  const POINTER = '"/__braid/speculation-rules.json"';

  it('is on composed pages, and on the pages passed to the app, which link to them', async () => {
    const braid = gateway([billing]);
    const app = toFetchHandler(braid, (request) =>
      new URL(request.url).pathname === '/' ? shell('<!doctype html><a href="/billing">Billing</a>')() : shell()(),
    );

    const composed = await app(page('/billing/invoices'));
    const home = await app(page('/'));

    expect(composed.headers.get('speculation-rules')).toBe(POINTER);
    expect(home.headers.get('speculation-rules')).toBe(POINTER);
    // the page itself is untouched: same body, and not made private by the header
    expect(await home.text()).toBe('<!doctype html><a href="/billing">Billing</a>');
    expect(home.headers.get('cache-control')).toBeNull();
  });

  it('is left to the binding for a page the gateway does not compose: handle() never reads the app', async () => {
    const braid = gateway([billing]);
    const app = vi.fn(shell('<!doctype html><p>home</p>'));

    expect(await braid.handle(page('/'), app)).toBeNull();
    expect(app).not.toHaveBeenCalled();
    expect(braid.pageHeaders(page('/'))).toEqual({ 'speculation-rules': POINTER });
  });

  it('is set by the Node binding before the app runs, which then writes to the real response', async () => {
    const braid = gateway([billing]);
    let patched: boolean | undefined;
    const server = createServer((req, res) =>
      toNodeMiddleware(braid)(req, res, () => {
        // the gateway's capture replaces `write` on the response; a passed-through page must not be captured
        patched = Object.prototype.hasOwnProperty.call(res, 'write');
        res.writeHead(200, { 'content-type': 'text/html' }).end('<p>home</p>');
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'sec-fetch-dest': 'document' } });
      expect(response.headers.get('speculation-rules')).toBe(POINTER);
      expect(await response.text()).toBe('<p>home</p>');
      expect(patched).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('is only for browser navigations', () => {
    const braid = gateway([billing]);

    expect(braid.pageHeaders(new Request(`${ORIGIN}/`, { headers: { accept: 'text/html' } }))).toBeNull();
    expect(braid.pageHeaders(new Request(`${ORIGIN}/`, { method: 'HEAD', headers: { 'sec-fetch-dest': 'document' } }))).toBeNull();
    expect(braid.pageHeaders(new Request(`${ORIGIN}/api`, { headers: { 'sec-fetch-dest': 'empty' } }))).toBeNull();
  });

  it('is not sent unless the gateway is asked to', async () => {
    const braid = gateway([billing], { speculationRules: false });

    const composed = await braid.handle(page('/billing'), shell());

    expect(composed?.headers.get('speculation-rules')).toBeNull();
    expect(braid.pageHeaders(page('/'))).toBeNull();
    expect((await braid.handle(new Request(RULES)))?.headers.get('content-type')).not.toBe(
      'application/speculationrules+json',
    );
  });
});

describe('the rules', () => {
  it('list the pierce patterns of the fragments that ask, by action', async () => {
    const braid = gateway([
      billing,
      { id: 'orders', pierce: ['/orders/:id'], speculate: 'prefetch' },
      { id: 'notifications', pierce: ['/inbox'] },
    ]);

    const response = await braid.handle(new Request(RULES));
    const rules = await response?.json();

    expect(response?.headers.get('content-type')).toBe('application/speculationrules+json');
    expect(response?.headers.get('cache-control')).toBe('public, max-age=60');
    const pathnames = (action: 'prefetch' | 'prerender') =>
      rules[action]?.[0].where.and[0].or.map((predicate: { href_matches: { pathname: string } }) => predicate.href_matches.pathname);
    // `/billing/*` also pierces `/billing/`'s slashless twin; `/billing` its slashed one
    expect(pathnames('prerender')).toEqual(['/billing', '/billing/', '/billing/*']);
    expect(pathnames('prefetch')).toEqual(['/orders/:id', '/orders/:id/']);
    expect(JSON.stringify(rules)).not.toContain('/inbox');
    expect(rules.prerender[0]).toMatchObject({ source: 'document', eagerness: 'moderate' });
    // links a page marks as not to be followed are never speculated
    expect(rules.prerender[0].where.and[1]).toEqual({ not: { selector_matches: '[rel~="nofollow"], [data-braid-no-speculate]' } });
  });

  it('leave out chrome, and patterns that would make every link speculative', () => {
    const rules = speculationRulesFor([
      { id: 'header', endpoint: 'https://h.internal/', pierce: ['/billing/*'], bound: false, speculate: 'prerender' },
      { id: 'everything', endpoint: 'https://e.internal/', pierce: ['/*', '/:page', '/', '/orders/:id'], speculate: 'prefetch' },
    ] as FragmentManifest[]);

    expect(rules.prerender).toBeUndefined();
    const prefetched = rules.prefetch![0].where.and[0].or.map((predicate) => predicate.href_matches.pathname);
    expect(prefetched).toEqual(['/', '/orders/:id', '/orders/:id/']);
  });

  it('match the URLs the gateway would compose', () => {
    const rules = speculationRulesFor([{ ...billing, endpoint: 'https://billing.internal/' } as FragmentManifest]);
    const patterns = rules.prerender![0].where.and[0].or.map(
      (predicate) => new URLPattern({ pathname: predicate.href_matches.pathname }),
    );
    const speculated = (path: string) => patterns.some((pattern) => pattern.test({ pathname: path }));

    for (const path of ['/billing', '/billing/', '/billing/invoices']) expect(speculated(path), path).toBe(true);
    for (const path of ['/', '/billings', '/orders']) expect(speculated(path), path).toBe(false);
  });

  describe('with access rules in the registry', () => {
    const registry: Partial<FragmentManifest>[] = [
      billing,
      { id: 'payroll', pierce: ['/payroll'], speculate: 'prerender', access: { fetch: { roles: ['hr'] } } },
      { id: 'secret', pierce: ['/secret'], speculate: 'prerender', access: { list: { roles: ['hr'] }, fetch: { roles: ['hr'] } } },
    ];
    const principal = (request: Request) => ({ roles: (request.headers.get('x-roles') ?? '').split(',').filter(Boolean) });

    it('leave out what the caller may not load or list, and are private to the caller', async () => {
      const braid = gateway(
        [...registry, { id: 'hidden', pierce: ['/hidden'], speculate: 'prerender', access: { list: { roles: ['hr'] } } }],
        { principal },
      );

      const response = await braid.handle(new Request(RULES));
      const body = JSON.stringify(await response?.json());

      expect(body).toContain('/billing');
      expect(body).not.toContain('/payroll');
      expect(body).not.toContain('/secret');
      // loadable by a deep link, but kept out of listings: its route is not published either
      expect(body).not.toContain('/hidden');
      expect(response?.headers.get('cache-control')).toBe('private, no-store');
      expect(response?.headers.get('vary')).toBe('cookie, authorization');
    });

    it('include it for a caller who may', async () => {
      const braid = gateway(registry, { principal });

      const response = await braid.handle(new Request(RULES, { headers: { 'x-roles': 'hr' } }));
      const body = JSON.stringify(await response?.json());

      expect(body).toContain('/payroll');
      expect(body).toContain('/secret');
      expect(response?.headers.get('cache-control')).toBe('private, no-store');
    });
  });
});

describe('caching', () => {
  it('is private whenever callers can be told apart, whatever the registry holds today', async () => {
    const braid = gateway([billing], { principal: () => ({ roles: [] }) });
    expect((await braid.handle(new Request(RULES)))?.headers.get('cache-control')).toBe('private, no-store');
  });

  it('is never stored in development, where nothing is filtered', async () => {
    const braid = gateway([{ ...billing, access: { fetch: { roles: ['hr'] } } }], { mode: 'development' });
    const response = await braid.handle(new Request(RULES));

    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(await response?.json())).toContain('/billing');
  });
});

describe('configuration', () => {
  it('refuses a basePath, like the other fixed endpoints', () => {
    expect(() => gateway([billing], { basePath: '/manage' })).toThrow(/speculationRules/);
  });

  it('refuses a speculate value it does not know', () => {
    expect(() => gateway([{ id: 'billing', pierce: ['/billing'], speculate: 'eager' as unknown as 'prerender' }])).toThrow(
      /speculate: "eager"/,
    );
  });
});
