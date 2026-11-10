import { describe, expect, it } from 'vitest';
import { createSnapshot } from './snapshot.js';
import { cacheSnapshotStore } from './store-cache.js';
import { createRegistryApi } from './api.js';
import { snapshotRegistry } from './source.js';

/** Cache Storage over Maps, as a browser's behaves for what the store uses. */
function fakeCaches(): CacheStorage & { names(): string[] } {
  const all = new Map<string, Map<string, Response>>();
  const urlOf = (request: RequestInfo | URL) => (request instanceof Request ? request.url : String(request));
  return {
    names: () => [...all.keys()],
    async open(name: string) {
      let entries = all.get(name);
      if (!entries) all.set(name, (entries = new Map()));
      const cache = entries;
      return {
        match: async (request: RequestInfo | URL) => cache.get(urlOf(request))?.clone(),
        put: async (request: RequestInfo | URL, response: Response) => void cache.set(urlOf(request), response),
        keys: async () => [...cache.keys()].map((url) => new Request(url)),
      } as unknown as Cache;
    },
  } as unknown as CacheStorage & { names(): string[] };
}

const billing = { id: 'billing', endpoint: 'https://billing.internal' };

describe('cacheSnapshotStore()', () => {
  it('keeps snapshots and HEAD across store instances, as across worker restarts', async () => {
    const caches = fakeCaches();
    const first = await createSnapshot({ manifests: [billing] });
    const second = await createSnapshot({ manifests: [billing, { id: 'reviews', endpoint: 'https://reviews.internal' }] });

    const store = cacheSnapshotStore({ caches });
    expect(await store.head?.()).toBeNull();
    expect(await store.get(first.id)).toBeNull();
    await store.put(first);
    await store.put(second);
    await store.put(first); // a no-op
    await store.setHead?.(second.id);

    const restarted = cacheSnapshotStore({ caches });
    expect(await restarted.head?.()).toBe(second.id);
    expect(await restarted.get(first.id)).toEqual(first);
    expect((await restarted.list()).map((ref) => ref.id).sort()).toEqual([first.id, second.id].sort());
    expect(await restarted.list({ limit: 1 })).toHaveLength(1);
    expect(caches.names()).toEqual(['braid-registry']);
  });

  it('refuses to point HEAD at a snapshot it does not hold, and keeps caches apart by name', async () => {
    const caches = fakeCaches();
    const snapshot = await createSnapshot({ manifests: [billing] });
    await cacheSnapshotStore({ caches, cacheName: 'a' }).put(snapshot);
    const other = cacheSnapshotStore({ caches, cacheName: 'b' });
    expect(await other.get(snapshot.id)).toBeNull();
    await expect(other.setHead?.(snapshot.id)).rejects.toThrow('unknown snapshot');
  });

  it('pages a listing with the same cursor the other stores use', async () => {
    const caches = fakeCaches();
    const store = cacheSnapshotStore({ caches });
    const snapshots = await Promise.all(['a', 'b', 'c'].map((id) => createSnapshot({ manifests: [{ id, endpoint: 'https://x.internal' }] })));
    for (const snapshot of snapshots) await store.put(snapshot);
    const [newest, ...rest] = await store.list();
    const after = await store.list({ before: `${newest.createdAt}~${newest.id}` });
    expect(after.map((ref) => ref.id)).toEqual(rest.map((ref) => ref.id));
  });

  it('backs the registry API and a gateway source: publish, then serve what was published', async () => {
    const store = cacheSnapshotStore({ caches: fakeCaches() });
    const api = createRegistryApi({ store, authorize: () => true });
    const published = await api.handle(
      new Request('https://app.example/__braid/registry-api/snapshots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifests: [billing], shells: [{ id: 'desk', framework: 'vanilla', routes: [{ path: '/desk', layout: { areas: 'main' } }] }] }),
      }),
    );
    expect(published?.status).toBe(201);
    const registry = snapshotRegistry({ store });
    expect((await registry()).map((manifest) => manifest.id)).toEqual(['billing']);
    expect((await registry.snapshot()).shells?.[0]?.id).toBe('desk');
  });
});
