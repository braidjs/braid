/**
 * Per-fragment IndexedDB and Cache Storage, for a compat fragment granted
 * `capabilities.storage: { databases: true }`.
 *
 * A compat realm is a same-origin iframe, so its `indexedDB` and `caches` are the origin's: two
 * fragments that both open a database called `app` open the same one, and the host sees it too.
 * `compat/storage-partition.ts` already gives each partition its own Web Storage and cookies; this
 * does the same for the databases.
 *
 * - **Where the browser has Storage Buckets** (Chromium), the realm gets a bucket of its own —
 *   `navigator.storageBuckets.open()` — and that bucket's `indexedDB` and `caches`. The browser
 *   keeps the data apart, and evicts, quotas and deletes it per bucket, so one fragment filling its
 *   store does not cost another its data.
 * - **Elsewhere**, the realm's own factory and cache storage are wrapped to prefix every name with
 *   the partition, and to list only the partition's own. `IDBDatabase.name` and a cache's key
 *   still show the prefix: an accident barrier, like the rest of the trusted tier, not a boundary.
 *
 * Installed before any fragment code runs. Opt-in, so a fragment's existing databases stay where
 * they are until it asks.
 */

export type DatabasePartitionKind = 'bucket' | 'prefixed';

interface StorageBucketLike {
  indexedDB: IDBFactory;
  caches: CacheStorage;
}

interface RealmWindowLike {
  indexedDB?: IDBFactory;
  caches?: CacheStorage;
  navigator: { storageBuckets?: { open(name: string): Promise<StorageBucketLike> } };
}

/** Gives the realm window its partition's `indexedDB` and `caches`; resolves with which kind. */
export async function installDatabasePartition(realm: Window, partition: string): Promise<DatabasePartitionKind> {
  const realmWindow = realm as unknown as RealmWindowLike;
  const buckets = realmWindow.navigator.storageBuckets;
  if (typeof buckets?.open === 'function') {
    try {
      const bucket = await buckets.open(bucketName(partition));
      define(realm, 'indexedDB', bucket.indexedDB);
      define(realm, 'caches', bucket.caches);
      return 'bucket';
    } catch {
      // refused (an opaque origin, a quota policy): fall back to prefixing
    }
  }
  const prefix = `braid:${encodeURIComponent(partition)}:`;
  if (realmWindow.indexedDB) define(realm, 'indexedDB', prefixedFactory(realmWindow.indexedDB, prefix));
  if (realmWindow.caches) define(realm, 'caches', prefixedCacheStorage(realmWindow.caches, prefix));
  return 'prefixed';
}

/**
 * A bucket name for a partition: lowercase letters, digits, `-` and `_`, at most 64 characters, as
 * the API requires. The readable part may collide after that folding; the hash of the exact
 * partition keeps two partitions apart.
 */
export function bucketName(partition: string): string {
  const readable = partition.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `braid-${readable || 'p'}-${fnv1a(partition)}`;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function define(realm: Window, name: 'indexedDB' | 'caches', value: unknown): void {
  Object.defineProperty(realm, name, { configurable: true, enumerable: true, get: () => value });
}

/** An `IDBFactory` whose databases are the partition's: same prototype, so `instanceof` holds. */
export function prefixedFactory(native: IDBFactory, prefix: string): IDBFactory {
  return Object.create(Object.getPrototypeOf(native), {
    open: {
      value: (name: string, version?: number) => (version === undefined ? native.open(prefix + name) : native.open(prefix + name, version)),
    },
    deleteDatabase: { value: (name: string) => native.deleteDatabase(prefix + name) },
    databases: {
      value: async () =>
        (await native.databases())
          .filter((info) => info.name?.startsWith(prefix))
          .map((info) => ({ ...info, name: info.name!.slice(prefix.length) })),
    },
    cmp: { value: (first: unknown, second: unknown) => native.cmp(first, second) },
  }) as IDBFactory;
}

/** A `CacheStorage` whose caches are the partition's. `match` looks only in those. */
export function prefixedCacheStorage(native: CacheStorage, prefix: string): CacheStorage {
  const own = async () => (await native.keys()).filter((name) => name.startsWith(prefix));
  return Object.create(Object.getPrototypeOf(native), {
    open: { value: (name: string) => native.open(prefix + name) },
    has: { value: (name: string) => native.has(prefix + name) },
    delete: { value: (name: string) => native.delete(prefix + name) },
    keys: { value: async () => (await own()).map((name) => name.slice(prefix.length)) },
    match: {
      value: async (request: RequestInfo | URL, options?: MultiCacheQueryOptions) => {
        if (options?.cacheName !== undefined) return native.match(request, { ...options, cacheName: prefix + options.cacheName });
        for (const name of await own()) {
          const found = await (await native.open(name)).match(request, options);
          if (found) return found;
        }
        return undefined;
      },
    },
  }) as CacheStorage;
}
