import { describe, expect, it } from 'vitest';
import { createGateway, type GatewayOptions } from './gateway.js';
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
  it('is on composed pages and on the pages the gateway passes through, which link to them', async () => {
    const braid = gateway([billing]);

    const composed = await braid.handle(page('/billing/invoices'), shell());
    const home = await braid.handle(page('/'), shell('<!doctype html><a href="/billing">Billing</a>'));

    expect(composed?.headers.get('speculation-rules')).toBe('"/__braid/speculation-rules.json"');
    expect(home?.headers.get('speculation-rules')).toBe('"/__braid/speculation-rules.json"');
    // the page itself is untouched: same body, and not made private by the header
    expect(await home?.text()).toBe('<!doctype html><a href="/billing">Billing</a>');
    expect(home?.headers.get('cache-control')).toBeNull();
  });

  it('is left off what is not an HTML page', async () => {
    const braid = gateway([billing]);

    const json = await braid.handle(page('/'), async () => Response.json({}));
    const api = await braid.handle(new Request(`${ORIGIN}/api/orders`, { headers: { accept: 'application/json' } }), shell());

    expect(json?.headers.get('speculation-rules')).toBeNull();
    expect(api).toBeNull();
  });

  it('is not sent unless the gateway is asked to', async () => {
    const braid = gateway([billing], { speculationRules: false });

    const composed = await braid.handle(page('/billing'), shell());

    expect(composed?.headers.get('speculation-rules')).toBeNull();
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
      rules[action]?.[0].where.or.map((predicate: { href_matches: { pathname: string } }) => predicate.href_matches.pathname);
    // `/billing/*` also pierces `/billing/`'s slashless twin; `/billing` its slashed one
    expect(pathnames('prerender')).toEqual(['/billing', '/billing/', '/billing/*']);
    expect(pathnames('prefetch')).toEqual(['/orders/:id', '/orders/:id/']);
    expect(JSON.stringify(rules)).not.toContain('/inbox');
    expect(rules.prerender[0]).toMatchObject({ source: 'document', eagerness: 'moderate' });
  });

  it('match the URLs the gateway would compose', () => {
    const rules = speculationRulesFor([{ ...billing, endpoint: 'https://billing.internal/' } as FragmentManifest]);
    const patterns = rules.prerender![0].where.or.map(
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

    it('leave out what the caller may not load, and are private to the caller', async () => {
      const braid = gateway(registry, { principal });

      const response = await braid.handle(new Request(RULES));
      const body = JSON.stringify(await response?.json());

      expect(body).toContain('/billing');
      expect(body).not.toContain('/payroll');
      expect(body).not.toContain('/secret');
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
