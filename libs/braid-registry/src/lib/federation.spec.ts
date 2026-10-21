import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGateway } from '@braidlabs/gateway';
import type { BraidGateway, FragmentManifest, Principal } from '@braidlabs/gateway';
import { subgraph, supergraph } from './supergraph.js';

/**
 * Two real gateways: a team's, serving its own app, and the org's, composing the team in as a
 * subgraph. The network between them is a stubbed `fetch` that hands requests for the team's host
 * to the team gateway — everything either gateway does with them is the code that ships.
 */
describe('a team gateway federated into an org gateway', () => {
  const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

  /** The team's fragment origin, private to the team's network. Records the paths it is asked for. */
  const originPaths: string[] = [];
  const originHeaders: Headers[] = [];
  const teamOrigin = (async (input: RequestInfo | URL) => {
    const request = new Request(input);
    const path = new URL(request.url).pathname;
    originPaths.push(path);
    originHeaders.push(request.headers);
    if (path === '/assets/app.js') return new Response('console.log("orders")', { headers: { 'content-type': 'text/javascript' } });
    return html(`<!doctype html><html><head><script src="/assets/app.js"></script></head><body><h1>Order ${path}</h1></body></html>`);
  }) as unknown as typeof fetch;

  const teamManifests: FragmentManifest[] = [
    { id: 'orders', endpoint: teamOrigin, pierce: ['/orders/*'] },
    { id: 'refunds', endpoint: teamOrigin, pierce: ['/refunds/*'], access: { fetch: { roles: ['refunds'] } } },
  ];

  /** Who the bearer token says the caller is. Both gateways resolve identity the same way. */
  const principal = (request: Request): Principal | undefined =>
    request.headers.get('authorization') === 'Bearer refunds-agent' ? { roles: ['refunds'] } : undefined;

  let teamGateway: BraidGateway;
  /** Requests that crossed the network to the team gateway. */
  const teamRequests: string[] = [];
  const teamShell = vi.fn(async () => html(`<html><body><nav>orders team</nav><fragment-slot name="orders"></fragment-slot></body></html>`));
  const orgShell = vi.fn(async () =>
    html(`<html><body><nav>org</nav><main><fragment-slot name="orders"></fragment-slot><fragment-slot name="refunds"></fragment-slot></main></body></html>`),
  );

  beforeEach(() => {
    originPaths.length = 0;
    originHeaders.length = 0;
    teamRequests.length = 0;
    teamShell.mockClear();
    orgShell.mockClear();

    teamGateway = createGateway({ mode: 'production', registry: teamManifests, principal, forwardCredentials: true });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).host !== 'orders.internal') throw new Error(`unexpected fetch to ${request.url}`);
      teamRequests.push(new URL(request.url).pathname);
      return (await teamGateway.handle(request, teamShell)) ?? new Response('not found', { status: 404 });
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function orgGateway(options: { forwardCredentials?: boolean } = {}) {
    return createGateway({
      mode: 'production',
      registry: supergraph([
        [{ id: 'home', endpoint: (async () => html('<h1>home</h1>')) as unknown as typeof fetch, pierce: ['/'] }],
        subgraph({ name: 'orders', url: 'https://orders.internal', registry: teamManifests }),
      ]),
      principal,
      ...options,
    });
  }

  const documentRequest = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://www.example.com${path}`, { headers: { 'sec-fetch-dest': 'document', ...headers } });

  it("pierces the team's fragment straight into the org shell — no shell within a shell", async () => {
    const response = await orgGateway().handle(documentRequest('/orders/42'), orgShell);
    const body = await response!.text();

    expect(response!.status).toBe(200);
    expect(orgShell).toHaveBeenCalledTimes(1);
    // the team's shell is never asked for anything: the org composes the team's fragment itself
    expect(teamShell).not.toHaveBeenCalled();
    expect(body).toContain('<nav>org</nav>');
    expect(body).not.toContain('orders team');
    expect(body.match(/shadowrootmode="open"/g)).toHaveLength(1);
    expect(body).toContain('<h1>Order /orders/42</h1>');
    // prepared once: inert once, re-rooted once, into the org's namespace for the team's fragment
    expect(body).toContain('<script src="/__braid/frag/orders/assets/app.js" type="inert"></script>');
    // the origin sees the page path, as it would behind the team's own gateway
    expect(originPaths).toEqual(['/orders/42']);
  });

  it("serves the team fragment's assets through the org namespace, unprefixed at the origin", async () => {
    const response = await orgGateway().handle(new Request('https://www.example.com/__braid/frag/orders/assets/app.js'));

    expect(response!.status).toBe(200);
    expect(await response!.text()).toBe('console.log("orders")');
    expect(originPaths).toEqual(['/assets/app.js']);
  });

  it('leaves the team gateway serving its own app, unchanged', async () => {
    const response = await teamGateway.handle(documentRequest('/orders/7'), teamShell);
    const body = await response!.text();

    expect(teamShell).toHaveBeenCalledTimes(1);
    expect(body).toContain('<nav>orders team</nav>');
    expect(body).toContain('<h1>Order /orders/7</h1>');
  });

  it("enforces the team's access rules through the org gateway, denying an anonymous caller", async () => {
    const response = await orgGateway({ forwardCredentials: true }).handle(
      new Request('https://www.example.com/__braid/frag/refunds/'),
    );

    // the org holds a copy of the team's rule, so an anonymous caller stops at the org's edge
    expect(response!.status).toBe(403);
    expect(teamRequests).toEqual([]);
    expect(originPaths).toEqual([]);
  });

  it('lets an entitled caller through both gateways when the org forwards credentials', async () => {
    const response = await orgGateway({ forwardCredentials: true }).handle(
      documentRequest('/refunds/9', { authorization: 'Bearer refunds-agent' }),
      orgShell,
    );
    const body = await response!.text();

    expect(body).toContain('<h1>Order /refunds/9</h1>');
    expect(originHeaders[0].get('authorization')).toBe('Bearer refunds-agent');
  });

  it('fails closed at the team gateway when the org strips credentials', async () => {
    // the org lets the caller through, but without forwardCredentials the team sees an anonymous request
    const response = await orgGateway().handle(
      new Request('https://www.example.com/__braid/frag/refunds/', { headers: { authorization: 'Bearer refunds-agent' } }),
    );

    expect(response!.status).toBe(403);
    // the org's edge let it through; the team gateway is the one that refused
    expect(teamRequests).toEqual(['/__braid/frag/refunds/']);
    expect(originPaths).toEqual([]);
  });
});
