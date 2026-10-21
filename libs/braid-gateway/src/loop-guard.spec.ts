import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGateway } from './gateway.js';
import type { BraidGateway } from './gateway.js';
import { BRAID_MAX_HOPS, BRAID_VIA_HEADER } from './protocol.js';

/**
 * Gateways can sit in front of gateways — that is what federation is — so a fragment request can
 * cross several of them. A registry that points a fragment back at a gateway already on the path
 * would otherwise recurse until each fetch's timeout fired, holding a request open at every hop.
 */
describe('gateway loop guard', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Routes the network for one host to a gateway, the way a fragment fetch to it would arrive. */
  function network(routes: Record<string, () => BraidGateway>) {
    const seen: Request[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request);
      const gateway = routes[new URL(request.url).host];
      if (gateway) return (await gateway().handle(request)) ?? new Response('not found', { status: 404 });
      return new Response('origin', { headers: { 'content-type': 'text/plain' } });
    });
    return seen;
  }

  it('stops a fragment whose endpoint loops back to the same gateway, without waiting out the timeout', async () => {
    let gateway: BraidGateway;
    const seen = network({ 'org.example': () => gateway });
    gateway = createGateway({
      mode: 'production',
      registry: [{ id: 'loop', endpoint: 'https://org.example/__braid/frag/loop/', timeoutMs: 30_000 }],
    });

    const started = Date.now();
    const response = await gateway.handle(new Request('https://org.example/__braid/frag/loop/app.js'));

    expect(Date.now() - started).toBeLessThan(1000);
    expect(response!.status).toBe(508);
    expect(seen).toHaveLength(BRAID_MAX_HOPS);
  });

  it('lets an ordinary chain through and tells the origin how many gateways it crossed', async () => {
    const team = createGateway({ mode: 'production', registry: [{ id: 'orders', endpoint: 'https://origin.internal' }] });
    const org = createGateway({
      mode: 'production',
      registry: [{ id: 'orders', endpoint: 'https://team.internal/__braid/frag/orders/' }],
    });
    const seen = network({ 'team.internal': () => team });

    const response = await org.handle(new Request('https://www.example/__braid/frag/orders/app.js'));

    expect(response!.status).toBe(200);
    expect(await response!.text()).toBe('origin');
    expect(seen.map((request) => request.headers.get(BRAID_VIA_HEADER))).toEqual(['braid', 'braid, braid']);
  });

  it('names the fragment once, not once per gateway it crossed', async () => {
    const team = createGateway({ mode: 'production', registry: [{ id: 'orders', endpoint: 'https://origin.internal' }] });
    const org = createGateway({
      mode: 'production',
      registry: [{ id: 'orders', endpoint: 'https://team.internal/__braid/frag/orders/' }],
    });
    network({ 'team.internal': () => team });

    const response = await org.handle(new Request('https://www.example/__braid/frag/orders/app.js'));

    expect(response!.headers.get('x-braid-fragment-id')).toBe('orders');
  });

  it(`refuses a request that has already crossed ${BRAID_MAX_HOPS} gateways`, async () => {
    const seen = network({});
    const gateway = createGateway({ mode: 'production', registry: [{ id: 'orders', endpoint: 'https://origin.internal' }] });
    const hops = Array.from({ length: BRAID_MAX_HOPS }, () => 'braid').join(', ');

    const response = await gateway.handle(
      new Request('https://www.example/__braid/frag/orders/app.js', { headers: { [BRAID_VIA_HEADER]: hops } }),
    );

    expect(response!.status).toBe(508);
    expect(seen).toHaveLength(0);
  });

  it('answers only fragment traffic with a 508, and never lets a cache keep it', async () => {
    network({});
    const gateway = createGateway({ mode: 'production', registry: [{ id: 'orders', endpoint: 'https://origin.internal' }] });
    const hops = { [BRAID_VIA_HEADER]: Array.from({ length: BRAID_MAX_HOPS }, () => 'braid').join(', ') };

    const fragment = await gateway.handle(new Request('https://www.example/__braid/frag/orders/a.js', { headers: hops }));
    expect(fragment!.status).toBe(508);
    expect(fragment!.headers.get('cache-control')).toBe('no-store');

    // a page request with a forged header is the shell's to answer, not a loop
    const page = await gateway.handle(new Request('https://www.example/about', { headers: hops }));
    expect(page).toBeNull();
  });

  it('counts websocket upgrades as hops, and refuses one that has crossed too many', async () => {
    const gateway = createGateway({ mode: 'production', registry: [{ id: 'orders', endpoint: 'https://origin.internal' }] });
    const upgrade = (via?: string) =>
      gateway.resolveUpgrade(
        new Request('https://www.example/__braid/frag/orders/ws', via ? { headers: { [BRAID_VIA_HEADER]: via } } : {}),
      );

    expect((await upgrade())?.via).toBe('braid');
    expect((await upgrade('braid'))?.via).toBe('braid, braid');
    expect(await upgrade(Array.from({ length: BRAID_MAX_HOPS }, () => 'braid').join(', '))).toBeNull();
  });
});
