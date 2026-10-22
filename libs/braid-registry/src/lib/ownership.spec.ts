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
