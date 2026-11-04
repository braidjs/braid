import { describe, expect, it } from 'vitest';
import { braidFetchHandler, pruneFragmentCaches } from './asset-handler.js';
import { clearBraidCaches } from './compose.js';
import { bucketFor, openFragmentCache, type StorageBucketsLike } from './fragment-caches.js';

/**
 * With `buckets: true` each fragment's cache lives in a Storage Bucket of its own, so the browser
 * evicts and deletes it per fragment; pruning a retired fragment deletes its bucket. Without it,
 * nothing changes. A fake bucket manager stands in for Chromium's.
 */

/** Cache storage held in memory: enough of the API for the handler. */
function memoryCaches(): CacheStorage & { contents: Map<string, Map<string, Response>> } {
  const contents = new Map<string, Map<string, Response>>();
  const cacheOf = (name: string): Cache => {
    let entries = contents.get(name);
    if (!entries) contents.set(name, (entries = new Map()));
    const key = (request: RequestInfo | URL) => (request instanceof Request ? request.url : String(request));
    return {
      match: async (request: RequestInfo | URL) => entries!.get(key(request))?.clone(),
      put: async (request: RequestInfo | URL, response: Response) => void entries!.set(key(request), response.clone()),
      delete: async (request: RequestInfo | URL) => entries!.delete(key(request)),
    } as unknown as Cache;
  };
  return {
    contents,
    open: async (name: string) => cacheOf(name),
    keys: async () => [...contents.keys()],
    delete: async (name: string) => contents.delete(name),
    has: async (name: string) => contents.has(name),
  } as unknown as CacheStorage & { contents: Map<string, Map<string, Response>> };
}

function fakeBuckets(): StorageBucketsLike & { buckets: Map<string, ReturnType<typeof memoryCaches>> } {
  const buckets = new Map<string, ReturnType<typeof memoryCaches>>();
  return {
    buckets,
    open: async (name: string) => {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new TypeError(`invalid bucket name ${name}`);
      if (!buckets.has(name)) buckets.set(name, memoryCaches());
      return { caches: buckets.get(name)! };
    },
    keys: async () => [...buckets.keys()],
    delete: async (name: string) => void buckets.delete(name),
  };
}

const asset = (id: string) => new Request(`https://shop.example/__braid/frag/${id}/main.abc123.js`);
const network = (async () => new Response('export {}', { headers: { 'content-type': 'text/javascript' } })) as unknown as typeof fetch;
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('per-fragment buckets', () => {
  it('keep each fragment’s files in a bucket of its own, not the shared cache storage', async () => {
    const shared = memoryCaches();
    const storageBuckets = fakeBuckets();
    const handle = braidFetchHandler({ buckets: true, storageBuckets, caches: shared, fetch: network });

    await handle(asset('billing'));
    await handle(asset('orders'));
    await settle();

    expect([...storageBuckets.buckets.keys()].sort()).toEqual([bucketFor('billing'), bucketFor('orders')].sort());
    expect(storageBuckets.buckets.get(bucketFor('billing'))!.contents.get('braid-frag:billing')?.size).toBe(1);
    expect(shared.contents.size).toBe(0);
  });

  it('are deleted when their fragment leaves the registry, along with any old shared caches', async () => {
    const shared = memoryCaches();
    await shared.open('braid-frag:billing'); // left from before the worker turned buckets on
    const storageBuckets = fakeBuckets();
    await storageBuckets.open(bucketFor('billing'));
    await storageBuckets.open(bucketFor('orders'));
    await storageBuckets.open('someone-elses-bucket');

    const removed = await pruneFragmentCaches(['billing'], { buckets: true, storageBuckets, caches: shared });

    expect([...storageBuckets.buckets.keys()].sort()).toEqual([bucketFor('billing'), 'someone-elses-bucket'].sort());
    expect(removed).toContain(bucketFor('orders'));
    // with buckets in use, the old shared caches are superseded, kept fragments' included
    expect(shared.contents.has('braid-frag:billing')).toBe(false);
  });

  it('never touch buckets that are not this worker’s: the realm’s databases, another prefix’s, the app’s', async () => {
    const storageBuckets = fakeBuckets();
    // what core names a realm database partition called "frag", and buckets that merely look alike
    const others = ['braid-db_frag_1a2b3c4d', 'braid-sw_braid-frag-v2_orders_1a2b3c4d', 'braid-sw_other_orders_1a2b3c4d', 'braid-frag-orders-1a2b3c4d', 'app-cache'];
    for (const name of others) await storageBuckets.open(name);
    await storageBuckets.open(bucketFor('orders'));

    await pruneFragmentCaches([], { buckets: true, storageBuckets, caches: memoryCaches() });
    expect([...storageBuckets.buckets.keys()].sort()).toEqual([...others].sort());

    await storageBuckets.open(bucketFor('orders'));
    await clearBraidCaches({ buckets: true, storageBuckets, caches: memoryCaches() });
    expect([...storageBuckets.buckets.keys()].sort()).toEqual([...others].sort());
  });

  it('are cleared at sign-out even by a worker that no longer uses them', async () => {
    const storageBuckets = fakeBuckets();
    await storageBuckets.open(bucketFor('billing'));

    await clearBraidCaches({ storageBuckets, caches: memoryCaches() });

    expect(storageBuckets.buckets.size).toBe(0);
  });

  it('are all deleted when the worker clears its caches at sign-out', async () => {
    const storageBuckets = fakeBuckets();
    await storageBuckets.open(bucketFor('billing'));
    await storageBuckets.open('someone-elses-bucket');

    await clearBraidCaches({ buckets: true, storageBuckets, caches: memoryCaches() });

    expect([...storageBuckets.buckets.keys()]).toEqual(['someone-elses-bucket']);
  });

  it('fall back to the shared cache storage when a bucket is refused', async () => {
    const shared = memoryCaches();
    const refusing: StorageBucketsLike = { open: async () => Promise.reject(new Error('quota policy')), keys: async () => [], delete: async () => undefined };

    await (await openFragmentCache('billing', { buckets: true, storageBuckets: refusing, caches: shared }))!.put('https://x/', new Response('x'));

    expect(shared.contents.get('braid-frag:billing')?.size).toBe(1);
  });

  it('are not used unless asked for', async () => {
    const shared = memoryCaches();
    const storageBuckets = fakeBuckets();
    const handle = braidFetchHandler({ storageBuckets, caches: shared, fetch: network });

    await handle(asset('billing'));
    await settle();

    expect(storageBuckets.buckets.size).toBe(0);
    expect(shared.contents.get('braid-frag:billing')?.size).toBe(1);
  });

  it('get names the API accepts, distinct for ids that fold to the same text', () => {
    for (const id of ['billing', 'Billing', 'billing app', 'a'.repeat(200), 'ünïcode/✓']) {
      expect(bucketFor(id)).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
    }
    expect(bucketFor('Billing')).not.toBe(bucketFor('billing'));
  });
});
