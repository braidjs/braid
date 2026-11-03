import { describe, expect, it, vi } from 'vitest';
import { createGateway } from './gateway.js';
import { canFetch, canList, satisfies } from './registry.js';
import type { FragmentManifest, ResolvedFragmentManifest } from './registry.js';

/**
 * `access.fetch` — who may actually load a fragment, as opposed to `access.list`, which only
 * governs whether it appears in discovery listings. Both are public by default.
 */

const endpoint = (async () => new Response('fragment', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;

function gateway(manifest: Partial<FragmentManifest>, principal?: () => { roles?: string[]; scopes?: string[] }) {
  return createGateway({
    registry: [{ id: 'reports', endpoint, ...manifest } as FragmentManifest],
    mode: 'production',
    principal,
  });
}

const fragmentRequest = () => new Request('https://example.com/__braid/frag/reports/');

describe('satisfies()', () => {
  const rule = (partial: Parameters<typeof satisfies>[0]) => partial;

  it('treats an absent rule as public', () => {
    expect(satisfies(undefined, undefined)).toBe(true);
  });

  it('accepts any one of the listed roles', () => {
    expect(satisfies(rule({ roles: ['a', 'b'] }), { roles: ['b'] })).toBe(true);
    expect(satisfies(rule({ roles: ['a', 'b'] }), { roles: ['c'] })).toBe(false);
  });

  it('requires all of the listed scopes', () => {
    expect(satisfies(rule({ scopes: ['x', 'y'] }), { scopes: ['x'] })).toBe(false);
    expect(satisfies(rule({ scopes: ['x', 'y'] }), { scopes: ['x', 'y', 'z'] })).toBe(true);
  });

  it('requires both dimensions when both are declared', () => {
    const both = rule({ roles: ['admin'], scopes: ['read'] });
    expect(satisfies(both, { roles: ['admin'] })).toBe(false);
    expect(satisfies(both, { scopes: ['read'] })).toBe(false);
    expect(satisfies(both, { roles: ['admin'], scopes: ['read'] })).toBe(true);
  });
});

describe('list and fetch are independent', () => {
  const manifest = (access: FragmentManifest['access']) =>
    ({ id: 'x', endpoint: 'https://x.internal', adapter: 'compat', timeoutMs: 1500, fallback: 'placeholder', access }) as ResolvedFragmentManifest;

  it('defaults both to public', () => {
    const open = manifest(undefined);
    expect(canList(open, undefined)).toBe(true);
    expect(canFetch(open, undefined)).toBe(true);
  });

  it('can restrict loading while staying listed', () => {
    const gated = manifest({ fetch: { roles: ['analyst'] } });
    expect(canList(gated, undefined)).toBe(true);
    expect(canFetch(gated, undefined)).toBe(false);
  });

  it('can restrict listing while staying loadable by deep link', () => {
    const unlisted = manifest({ list: { roles: ['insider'] } });
    expect(canList(unlisted, undefined)).toBe(false);
    expect(canFetch(unlisted, undefined)).toBe(true);
  });
});

describe('gateway enforcement of access.fetch', () => {
  it('serves a public fragment without ever resolving a principal', async () => {
    const principal = vi.fn(() => ({ roles: [] }));
    const response = await gateway({}, principal).handle(fragmentRequest());

    expect(response!.status).toBe(200);
    // a fully public registry must not pay for session lookup on every asset request
    expect(principal).not.toHaveBeenCalled();
  });

  it('serves a restricted fragment to an authorized caller', async () => {
    const response = await gateway({ access: { fetch: { roles: ['analyst'] } } }, () => ({
      roles: ['analyst'],
    })).handle(fragmentRequest());

    expect(response!.status).toBe(200);
  });

  it('403s a caller who may list it but not load it', async () => {
    const response = await gateway({ access: { fetch: { roles: ['analyst'] } } }, () => ({ roles: [] })).handle(
      fragmentRequest(),
    );

    expect(response!.status).toBe(403);
  });

  it('404s a caller who may not even list it, rather than confirming it exists', async () => {
    const response = await gateway(
      { access: { list: { roles: ['insider'] }, fetch: { roles: ['insider'] } } },
      () => ({ roles: [] }),
    ).handle(fragmentRequest());

    expect(response!.status).toBe(404);
    expect(await response!.text()).not.toContain('reports');
  });

  it('applies to every request in the namespace, not just the document', async () => {
    const restricted = gateway({ access: { fetch: { roles: ['analyst'] } } }, () => ({ roles: [] }));

    const asset = await restricted.handle(new Request('https://example.com/__braid/frag/reports/app.js'));
    const stub = await restricted.handle(new Request('https://example.com/__braid/realm/reports/'));
    const document = await restricted.handle(new Request('https://example.com/__braid/doc/reports/'));

    expect(asset!.status).toBe(403);
    expect(stub!.status).toBe(403);
    expect(document!.status).toBe(403);
  });

  it('does not pierce a fragment the caller may not load', async () => {
    const restricted = createGateway({
      registry: [
        {
          id: 'reports',
          endpoint,
          pierce: ['/dashboard'],
          access: { fetch: { roles: ['analyst'] } },
        },
      ],
      mode: 'production',
      principal: () => ({ roles: [] }),
    });

    const shell = async () =>
      new Response('<html><body><fragment-slot name="reports"></fragment-slot></body></html>', {
        headers: { 'content-type': 'text/html' },
      });

    const response = await restricted.handle(
      new Request('https://example.com/dashboard', { headers: { 'sec-fetch-dest': 'document' } }),
      shell,
    );

    // the page still renders; the slot is simply not filled
    const body = await response!.text();
    expect(body).toContain('<fragment-slot name="reports">');
    expect(body).not.toContain('shadowrootmode');
  });

  it('pierces normally for an authorized caller', async () => {
    const permitted = createGateway({
      registry: [
        { id: 'reports', endpoint, pierce: ['/dashboard'], access: { fetch: { roles: ['analyst'] } } },
      ],
      mode: 'production',
      principal: () => ({ roles: ['analyst'] }),
    });

    const shell = async () =>
      new Response('<html><body><fragment-slot name="reports"></fragment-slot></body></html>', {
        headers: { 'content-type': 'text/html' },
      });

    const body = await (await permitted.handle(
      new Request('https://example.com/dashboard', { headers: { 'sec-fetch-dest': 'document' } }),
      shell,
    ))!.text();

    expect(body).toContain('shadowrootmode');
  });

  it('bypasses access rules in development, so local work needs no session wiring', async () => {
    const dev = createGateway({
      registry: [{ id: 'reports', endpoint, access: { fetch: { roles: ['analyst'] } } }],
      mode: 'development',
      principal: () => ({ roles: [] }),
    });

    expect((await dev.handle(fragmentRequest()))!.status).toBe(200);
  });
});

/**
 * Development skips every access rule, so a gateway created without `mode` must not be one: a
 * deployment that forgot the option would otherwise serve gated fragments to anyone.
 */
describe('a gateway created without mode', () => {
  const gated = {
    id: 'reports',
    endpoint: 'https://reports.internal',
    pierce: ['/dashboard'],
    access: { fetch: { roles: ['analyst'] }, list: { roles: ['analyst'] } },
  } satisfies FragmentManifest;
  const anonymous = () =>
    createGateway({ registry: [gated], principal: () => ({ roles: [] }), discovery: {} });

  it('refuses a gated fragment on the namespace', async () => {
    const response = await anonymous().handle(fragmentRequest());
    expect(response!.status).toBe(404);
  });

  it('does not pierce a gated fragment', async () => {
    const shell = async () =>
      new Response('<html><body><fragment-slot name="reports"></fragment-slot></body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    // an endpoint that answers, so only the access rule can keep the slot empty
    const live = createGateway({ registry: [{ ...gated, endpoint }], principal: () => ({ roles: [] }) });
    const response = await live.handle(
      new Request('https://example.com/dashboard', { headers: { 'sec-fetch-dest': 'document' } }),
      shell,
    );
    expect(await response!.text()).not.toContain('shadowrootmode');
  });

  it('refuses a gated fragment websocket upgrade', async () => {
    const upgrade = new Request('https://example.com/__braid/frag/reports/socket', {
      headers: { upgrade: 'websocket', connection: 'upgrade' },
    });
    expect(await anonymous().resolveUpgrade(upgrade)).toBeNull();
  });

  it('filters discovery by principal and leaves endpoints out', async () => {
    const response = await anonymous().handle(new Request('https://example.com/__braid/registry'));
    const body = await response!.text();
    expect(body).not.toContain('reports');
    expect(body).not.toContain('reports.internal');
    expect(body).not.toContain('unfiltered');
  });
});
