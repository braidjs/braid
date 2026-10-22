import { describe, expect, it } from 'vitest';
import type { FragmentManifest } from '@braidlabs/gateway';
import { createRegistryApi } from './api.js';
import { memorySnapshotStore } from './store.js';
import { createSnapshot } from './snapshot.js';
import type { ShellManifest } from './shell.js';
import type { AuditEvent } from './audit.js';

const BASE = 'https://ops.example/__braid/registry-api';

const billing: FragmentManifest = { id: 'billing', endpoint: 'https://billing.internal', tags: ['finance'] };
const reviews: FragmentManifest = { id: 'reviews', endpoint: 'https://reviews.internal', tags: ['react'] };
const legacy: FragmentManifest = { id: 'legacy', endpoint: 'https://legacy.internal' };
const storefront: ShellManifest = {
  id: 'storefront',
  framework: 'vanilla',
  tags: ['finance'],
  routes: [{ path: '/billing/*', layout: { areas: 'main' }, slots: { main: 'billing' } }],
};

/** An API whose callers own the tags their `x-tags` header lists, or everything with `*`. */
async function ownedApi() {
  const events: AuditEvent[] = [];
  const base = await createSnapshot({ manifests: [billing, reviews, legacy], shells: [storefront] });
  const store = memorySnapshotStore([base]);
  const api = createRegistryApi({
    store,
    authorize: () => true,
    owns: (request) => {
      const header = request.headers.get('x-tags') ?? '';
      return header === '*' ? '*' : header.split(',').filter(Boolean);
    },
    audit: (event) => void events.push(event),
  });
  return { api, store, base, events };
}

const publish = (tags: string, body: unknown) =>
  new Request(`${BASE}/snapshots`, { method: 'POST', headers: { 'x-tags': tags }, body: JSON.stringify(body) });

describe('per-tag ownership', () => {
  it('lets an owner change what carries their tag', async () => {
    const { api } = await ownedApi();

    const response = await api.handle(
      publish('finance', { manifests: [{ ...billing, title: 'Billing v2' }, reviews, legacy] }),
    );

    expect(response!.status).toBe(201);
  });

  it("refuses a change to another team's fragment, naming it", async () => {
    const { api, events } = await ownedApi();

    const response = await api.handle(publish('finance', { manifests: [billing, { ...reviews, title: 'Hijacked' }, legacy] }));

    expect(response!.status).toBe(403);
    const body = await response!.json();
    expect(body.error).toContain('reviews');
    expect(body.items).toEqual([{ kind: 'fragment', id: 'reviews', tags: ['react'] }]);
    expect(events).toEqual([expect.objectContaining({ action: 'publish', outcome: 'denied', status: 403 })]);
  });

  it('refuses removing, or adding, an item outside the caller\'s tags', async () => {
    const { api } = await ownedApi();

    expect((await api.handle(publish('finance', { manifests: [billing, legacy] })))!.status).toBe(403);
    expect(
      (await api.handle(publish('finance', { manifests: [billing, reviews, legacy, { id: 'cart', endpoint: 'https://c.internal', tags: ['react'] }] })))!
        .status,
    ).toBe(403);
  });

  it('refuses taking over an item by retagging it', async () => {
    const { api } = await ownedApi();

    // finance may not claim reviews by giving it the finance tag…
    expect((await api.handle(publish('finance', { manifests: [billing, { ...reviews, tags: ['finance'] }, legacy] })))!.status).toBe(403);
    // …nor hand billing to react, which would lock finance out of its own fragment
    expect((await api.handle(publish('finance', { manifests: [{ ...billing, tags: ['react'] }, reviews, legacy] })))!.status).toBe(403);
    // keeping one of its own tags while adding another team's is allowed
    expect(
      (await api.handle(publish('finance,react', { manifests: [{ ...billing, tags: ['finance', 'react'] }, reviews, legacy] })))!.status,
    ).toBe(201);
  });

  it('needs * for an untagged item, which no team owns', async () => {
    const { api } = await ownedApi();

    expect((await api.handle(publish('finance', { manifests: [billing, reviews, { ...legacy, title: 'x' }] })))!.status).toBe(403);
    expect((await api.handle(publish('*', { manifests: [billing, reviews, { ...legacy, title: 'x' }] })))!.status).toBe(201);
  });

  it('applies the same rule to shells', async () => {
    const { api } = await ownedApi();
    const changed = { ...storefront, title: 'Storefront v2' };

    expect((await api.handle(publish('react', { manifests: [billing, reviews, legacy], shells: [changed] })))!.status).toBe(403);
    expect((await api.handle(publish('finance', { manifests: [billing, reviews, legacy], shells: [changed] })))!.status).toBe(201);
  });

  it('checks a pin by what it changes, so a pin cannot do what a publish may not', async () => {
    const { api, store, base } = await ownedApi();
    const other = await createSnapshot({ manifests: [billing, { ...reviews, title: 'Reviews v2' }, legacy], shells: [storefront] });
    await store.put(other);
    const pin = (tags: string, id: string) =>
      new Request(`${BASE}/head`, { method: 'POST', headers: { 'x-tags': tags }, body: JSON.stringify({ id }) });

    expect((await api.handle(pin('finance', other.id)))!.status).toBe(403);
    expect((await api.handle(pin('react', other.id)))!.status).toBe(200);
    expect((await api.handle(pin('react', base.id)))!.status).toBe(200);
  });

  it('refuses a new fragment that would pierce into routes another team owns', async () => {
    const { api } = await ownedApi();
    const intruder = { id: 'promo', endpoint: 'https://promo.internal', tags: ['react'], pierce: ['/billing/*'] };
    const ownBilling = { ...billing, pierce: ['/billing/*'] };
    // billing pierces /billing/* in this test's HEAD
    const base = await createSnapshot({ manifests: [ownBilling, reviews, legacy], shells: [storefront] });
    const store = memorySnapshotStore([base]);
    const scoped = createRegistryApi({ store, authorize: () => true, owns: (r) => (r.headers.get('x-tags') ?? '').split(',') });

    const response = await scoped.handle(publish('react', { manifests: [ownBilling, reviews, legacy, intruder] }));

    expect(response!.status).toBe(403);
    expect((await response!.json()).items).toEqual([expect.objectContaining({ kind: 'route', id: 'promo' })]);
    void api;
  });

  it("refuses a shell of the caller's own whose routes would answer another team's pages", async () => {
    const { api } = await ownedApi();
    // react owns this shell, and an id sorting before "storefront" would win /billing/:id
    const intruder: ShellManifest = {
      id: 'aaa',
      framework: 'vanilla',
      tags: ['react'],
      routes: [{ path: '/billing/:id', layout: { areas: 'main' }, slots: { main: 'reviews' } }],
    };

    const response = await api.handle(publish('react', { manifests: [billing, reviews, legacy], shells: [storefront, intruder] }));

    expect(response!.status).toBe(403);
    const body = await response!.json();
    expect(body.items).toEqual([{ kind: 'shell-route', id: 'aaa', tags: ['finance'] }]);
    expect(body.error).toContain('shell "aaa", whose routes would answer pages a shell tagged finance already answers');

    // a route of its own, overlapping nothing, is fine
    const own = { ...intruder, routes: [{ ...intruder.routes[0]!, path: '/reviews/*' }] };
    expect((await api.handle(publish('react', { manifests: [billing, reviews, legacy], shells: [storefront, own] })))!.status).toBe(201);
  });

  it('refuses shell routes crafted to slip past a sampled overlap check', async () => {
    const { api } = await ownedApi();
    // finance's storefront answers /billing/*; each of these also answers a page under it
    for (const path of ['/bill{ing}/:x(\\d+)', '/(billing)/:x(\\d+)', '/billing/:x(\\d+)/:y?']) {
      const intruder: ShellManifest = { id: 'aaa', framework: 'vanilla', tags: ['react'], routes: [{ path, layout: { areas: 'main' }, slots: { main: 'reviews' } }] };
      const response = await api.handle(publish('react', { manifests: [billing, reviews, legacy], shells: [storefront, intruder] }));
      expect(response!.status, path).toBe(403);
    }
  });

  it('refuses a route that differs from another team\'s only by a trailing slash', async () => {
    const exact: ShellManifest = { ...storefront, id: 'zbilling', routes: [{ ...storefront.routes[0]!, path: '/billing' }] };
    const base = await createSnapshot({ manifests: [billing, reviews, legacy], shells: [exact] });
    const api = createRegistryApi({ store: memorySnapshotStore([base]), authorize: () => true, owns: (r) => (r.headers.get('x-tags') ?? '').split(',') });
    const slashed: ShellManifest = { id: 'aaa', framework: 'vanilla', tags: ['react'], routes: [{ path: '/billing/', layout: { areas: 'main' }, slots: { main: 'reviews' } }] };

    expect((await api.handle(publish('react', { manifests: [billing, reviews, legacy], shells: [exact, slashed] })))!.status).toBe(403);
  });

  it('treats widening a route that already overlapped as a new claim', async () => {
    const promo: ShellManifest = { id: 'apromo', framework: 'vanilla', tags: ['react'], routes: [{ path: '/billing/promo', layout: { areas: 'main' }, slots: { main: 'reviews' } }] };
    const base = await createSnapshot({ manifests: [billing, reviews, legacy], shells: [storefront, promo] });
    const api = createRegistryApi({ store: memorySnapshotStore([base]), authorize: () => true, owns: (r) => (r.headers.get('x-tags') ?? '').split(',') });
    const widen = (path: string) => ({ ...promo, routes: [{ ...promo.routes[0]!, path }] });

    // the overlap that was already there is grandfathered: changing something else is fine
    expect((await api.handle(publish('react', { manifests: [billing, reviews, legacy], shells: [storefront, { ...promo, title: 'Promo' }] })))!.status).toBe(201);
    for (const path of ['/billing/:any', '/*']) {
      expect((await api.handle(publish('react', { manifests: [billing, reviews, legacy], shells: [storefront, widen(path)] })))!.status, path).toBe(403);
    }
  });

  it('does not lock a team out of its shell over an overlap that was already in HEAD', async () => {
    const theirs: ShellManifest = { ...storefront, id: 'promo', tags: ['react'], routes: [{ ...storefront.routes[0]!, path: '/billing/:id' }] };
    const base = await createSnapshot({ manifests: [billing, reviews, legacy], shells: [storefront, theirs] });
    const api = createRegistryApi({ store: memorySnapshotStore([base]), authorize: () => true, owns: (r) => (r.headers.get('x-tags') ?? '').split(',') });

    const response = await api.handle(
      publish('finance', { manifests: [billing, reviews, legacy], shells: [{ ...storefront, title: 'Storefront v2' }, theirs] }),
    );

    expect(response!.status).toBe(201);
  });

  it('refuses a publish that would replace a HEAD that moved meanwhile, even without baseId', async () => {
    const { api, store, base } = await ownedApi();
    const theirs = await createSnapshot({ manifests: [billing, { ...reviews, title: 'React team hotfix' }, legacy], shells: [storefront] });
    await store.put(theirs);
    const realHead = store.head!.bind(store);
    let reads = 0;
    // HEAD moves between the ownership check and the pin, as a slow publish would see it
    store.head = async () => (++reads === 1 ? base.id : theirs.id);
    void realHead;

    const response = await api.handle(publish('finance', { manifests: [{ ...billing, title: 'Billing v2' }, reviews, legacy] }));

    expect(response!.status).toBe(409);
  });

  it('fails closed with a generic answer when owns throws', async () => {
    const base = await createSnapshot({ manifests: [billing] });
    const api = createRegistryApi({
      store: memorySnapshotStore([base]),
      authorize: () => true,
      owns: () => {
        throw new Error('idp unreachable at https://internal.example/jwks');
      },
    });

    const response = await api.handle(publish('finance', { manifests: [{ ...billing, title: 'x' }] }));

    expect(response!.status).toBe(503);
    expect(JSON.stringify(await response!.json())).not.toContain('internal.example');
  });

  it('treats tags that are not a list as no tags, and duplicates as unowned', async () => {
    const { api } = await ownedApi();

    expect(
      (await api.handle(publish('finance', { manifests: [{ ...billing, tags: 'finance' as unknown as string[] }, reviews, legacy] })))!.status,
    ).toBe(403);
  });

  it('reports the caller\'s tags in /permissions, so a UI can offer only what will work', async () => {
    const { api } = await ownedApi();

    const own = await (await api.handle(new Request(`${BASE}/permissions`, { headers: { 'x-tags': 'finance' } })))!.json();
    const all = await (await api.handle(new Request(`${BASE}/permissions`, { headers: { 'x-tags': '*' } })))!.json();

    expect(own.tags).toEqual(['finance']);
    expect(all.tags).toBe('*');
  });

  it('changes nothing for an API without owns', async () => {
    const base = await createSnapshot({ manifests: [billing, reviews] });
    const api = createRegistryApi({ store: memorySnapshotStore([base]), authorize: () => true });

    const response = await api.handle(
      new Request(`${BASE}/snapshots`, { method: 'POST', body: JSON.stringify({ manifests: [billing, { ...reviews, title: 'x' }] }) }),
    );
    const permissions = await (await api.handle(new Request(`${BASE}/permissions`)))!.json();

    expect(response!.status).toBe(201);
    expect(permissions.tags).toBeNull();
  });
});
