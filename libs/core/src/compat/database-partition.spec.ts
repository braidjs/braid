import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { bucketName, clearBraidDatabases, installDatabasePartition, prefixedCacheStorage, prefixedFactory } from './database-partition.js';

/**
 * The prefixing path is what every browser without Storage Buckets gets, so it is held to the
 * native API's behaviour here; the bucket path, and which one a partition takes, are checked with
 * fakes. The e2e test runs both in Chromium.
 */

const opened = (request: IDBOpenDBRequest) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const settled = (request: IDBRequest) =>
  new Promise<void>((resolve) => {
    request.onsuccess = request.onerror = () => resolve();
  });

/** Cache storage held in memory, enough for the wrapper. */
function memoryCaches(): CacheStorage {
  const caches = new Map<string, Map<string, Response>>();
  const cacheOf = (name: string) => {
    if (!caches.has(name)) caches.set(name, new Map());
    const entries = caches.get(name)!;
    return {
      put: async (key: string, response: Response) => void entries.set(key, response),
      match: async (key: string) => entries.get(key)?.clone(),
    } as unknown as Cache;
  };
  return {
    open: async (name: string) => cacheOf(name),
    has: async (name: string) => caches.has(name),
    delete: async (name: string) => caches.delete(name),
    keys: async () => [...caches.keys()],
    match: async (key: string, options?: { cacheName?: string }) =>
      options?.cacheName && caches.has(options.cacheName) ? cacheOf(options.cacheName).match(key) : undefined,
  } as unknown as CacheStorage;
}

describe('prefixedFactory', () => {
  it('opens, lists and deletes only the partition’s databases, under their own names', async () => {
    const native = new IDBFactory();
    const partition = prefixedFactory(native, 'braid:orders:');
    (await opened(native.open('host-db'))).close();

    const db = await opened(partition.open('app', 3));
    expect(db.version).toBe(3);
    db.close();
    (await opened(partition.open('app'))).close();

    expect((await partition.databases()).map((info) => info.name)).toEqual(['app']);
    expect((await native.databases()).map((info) => info.name).sort()).toEqual(['braid:orders:app', 'host-db']);

    await settled(partition.deleteDatabase('app'));
    expect(await partition.databases()).toEqual([]);
    expect((await native.databases()).map((info) => info.name)).toEqual(['host-db']);
  });

  it('keeps the native prototype, and has databases() only where the native factory does', () => {
    const native = new IDBFactory();
    expect(prefixedFactory(native, 'p:') instanceof IDBFactory).toBe(true);

    const withoutListing = Object.create(native, { databases: { value: undefined } }) as IDBFactory;
    expect(typeof prefixedFactory(withoutListing, 'p:').databases).toBe('undefined');
  });
});

describe('prefixedCacheStorage', () => {
  it('opens, lists, checks and deletes only the partition’s caches, and matches only in them', async () => {
    const native = memoryCaches();
    await (await native.open('host')).put('/thing', new Response('host'));
    const partition = prefixedCacheStorage(native, 'braid:orders:');

    await (await partition.open('assets')).put('/thing', new Response('orders'));

    expect(await partition.keys()).toEqual(['assets']);
    expect(await partition.has('assets')).toBe(true);
    expect(await partition.has('host')).toBe(false);
    expect(await (await partition.match('/thing'))?.text()).toBe('orders');
    expect(await (await partition.match('/thing', { cacheName: 'assets' }))?.text()).toBe('orders');
    expect(await partition.match('/thing', { cacheName: 'host' })).toBeUndefined();

    await partition.delete('assets');
    expect(await native.keys()).toEqual(['host']);
  });
});

describe('bucketName', () => {
  it('is a valid bucket name in its own namespace, distinct for partitions that fold alike', () => {
    for (const partition of ['orders', 'Orders', 'my orders', '_x', 'a'.repeat(200), 'ünï/✓']) {
      expect(bucketName(partition)).toMatch(/^braid-db_[a-z0-9-]{1,40}_[0-9a-f]{8}$/);
    }
    expect(bucketName('Orders')).not.toBe(bucketName('orders'));
  });
});

describe('installDatabasePartition', () => {
  function realm(options: { existing?: string[]; bucketsRefuse?: boolean } = {}) {
    const native = new IDBFactory();
    const buckets = new Map<string, { indexedDB: IDBFactory; caches: CacheStorage }>();
    const window = {
      indexedDB: native,
      caches: memoryCaches(),
      navigator: {
        storageBuckets: {
          open: async (name: string) => {
            if (options.bucketsRefuse) throw new Error('quota policy');
            if (!buckets.has(name)) buckets.set(name, { indexedDB: new IDBFactory(), caches: memoryCaches() });
            return buckets.get(name)!;
          },
        },
      },
    };
    return { window: window as unknown as Window & typeof window, native, buckets, ready: Promise.all((options.existing ?? []).map(async (name) => (await opened(native.open(name))).close())) };
  }

  it('gives the realm a bucket of its own where the browser has them', async () => {
    const { window, buckets, ready } = realm();
    await ready;
    expect(await installDatabasePartition(window, 'orders')).toBe('bucket');
    expect(window.indexedDB).toBe(buckets.get(bucketName('orders'))!.indexedDB);
  });

  it('stays on prefixed names where the partition already has data there, so nothing is stranded', async () => {
    const { window, native, ready } = realm({ existing: ['braid:orders:app'] });
    await ready;
    expect(await installDatabasePartition(window, 'orders')).toBe('prefixed');
    expect(window.indexedDB).not.toBe(native);
    expect((await window.indexedDB.databases()).map((info) => info.name)).toEqual(['app']);
  });

  it('falls back to prefixed names when a bucket is refused', async () => {
    const { window, ready } = realm({ bucketsRefuse: true });
    await ready;
    expect(await installDatabasePartition(window, 'orders')).toBe('prefixed');
  });
});

describe('clearBraidDatabases', () => {
  it('deletes the partitions’ buckets, databases and caches, and nothing else on the origin', async () => {
    const native = new IDBFactory();
    for (const name of ['braid:orders:app', 'host-db']) (await opened(native.open(name))).close();
    const caches = memoryCaches();
    await caches.open('braid:orders:assets');
    await caches.open('host-assets');
    const buckets = new Set([bucketName('orders'), 'braid-sw_braid-frag_orders_1a2b3c4d', 'app-bucket']);
    const window = {
      indexedDB: native,
      caches,
      navigator: { storageBuckets: { keys: async () => [...buckets], delete: async (name: string) => void buckets.delete(name) } },
    } as unknown as Window;

    await clearBraidDatabases(window);

    expect([...buckets].sort()).toEqual(['app-bucket', 'braid-sw_braid-frag_orders_1a2b3c4d']);
    expect((await native.databases()).map((info) => info.name)).toEqual(['host-db']);
    expect(await caches.keys()).toEqual(['host-assets']);
  });
});
