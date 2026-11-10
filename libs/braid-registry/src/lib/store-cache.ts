import type { RegistrySnapshot } from './snapshot.js';
import { compareRefs, isAfterCursor, toRef, type SnapshotStore } from './store.js';

export interface CacheSnapshotStoreOptions {
  /** The Cache Storage cache the snapshots are kept in. Defaults to `braid-registry`. */
  cacheName?: string;
  /** Defaults to the global `caches`. */
  caches?: CacheStorage;
}

/**
 * A snapshot store in the browser's Cache Storage, for a registry that runs where there is no
 * server: inside a service worker, next to the in-worker gateway (`@braidlabs/sw/gateway`).
 *
 * Cache Storage rather than memory because a worker is stopped whenever it is idle, and rather
 * than IndexedDB because a snapshot is exactly what a cache holds — an immutable document under a
 * key. It is durable as far as the browser's storage is: per origin and browser profile, and gone
 * when the user clears site data. That makes it a place to design and preview, not a system of
 * record — nobody else's browser sees what is published here.
 *
 * Tracks HEAD; has no environments. Two tabs publishing at once are serialized only by the
 * registry API's `baseId` check, as with any store.
 */
export function cacheSnapshotStore(options: CacheSnapshotStoreOptions = {}): SnapshotStore {
  const open = () => (options.caches ?? globalThis.caches).open(options.cacheName ?? 'braid-registry');
  // a cache is keyed by URL; these are never fetched, so the host only has to be one nothing answers
  const key = (path: string) => `https://registry.braid.invalid/${path}`;
  const snapshotKey = (id: string) => key(`snapshots/${encodeURIComponent(id)}`);
  const HEAD = key('head');

  async function read(cache: Cache, url: string): Promise<RegistrySnapshot | null> {
    const response = await cache.match(url);
    if (!response) return null;
    try {
      return (await response.json()) as RegistrySnapshot;
    } catch {
      // not something this store wrote: as good as absent
      return null;
    }
  }

  return {
    async get(id) {
      return read(await open(), snapshotKey(id));
    },
    async put(snapshot) {
      const cache = await open();
      if (await cache.match(snapshotKey(snapshot.id))) return;
      await cache.put(snapshotKey(snapshot.id), new Response(JSON.stringify(snapshot), { headers: { 'content-type': 'application/json' } }));
    },
    async list({ limit, before } = {}) {
      const cache = await open();
      const prefix = key('snapshots/');
      const stored = await Promise.all((await cache.keys()).filter((request) => request.url.startsWith(prefix)).map((request) => read(cache, request.url)));
      const refs = stored
        .filter((snapshot): snapshot is RegistrySnapshot => snapshot !== null && typeof snapshot.id === 'string' && Array.isArray(snapshot.manifests))
        .map(toRef)
        .sort(compareRefs)
        .filter((ref) => before === undefined || isAfterCursor(ref, before));
      return limit === undefined ? refs : refs.slice(0, limit);
    },
    async head() {
      const response = await (await open()).match(HEAD);
      return response ? (await response.text()) || null : null;
    },
    async setHead(id) {
      const cache = await open();
      if (!(await cache.match(snapshotKey(id)))) {
        throw new Error(`braid-registry: cannot point head at unknown snapshot "${id}"`);
      }
      await cache.put(HEAD, new Response(id, { headers: { 'content-type': 'text/plain' } }));
    },
  };
}
