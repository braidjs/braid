/**
 * Where a fragment's cached files live: one Cache Storage cache per fragment (`braid-frag:<id>`),
 * or, with `buckets: true` where the browser has Storage Buckets (Chromium), that same cache inside
 * a bucket of the fragment's own.
 *
 * A bucket is the browser's unit of eviction, quota and deletion. In one shared Cache Storage, a
 * device short on space can evict every fragment's files at once, and the deploy-skew save — the
 * chunk an old page still asks for after a deploy — goes with them. Per-fragment buckets are evicted
 * one fragment at a time, and pruning a fragment that left the registry deletes its bucket outright.
 *
 * Opt-in: turning it on moves where files are kept, so a worker that switches starts with empty
 * fragment caches once (pruning removes the old ones).
 */

/** The per-fragment cache prefix, unless a worker names its own. */
export const DEFAULT_CACHE_PREFIX = 'braid-frag';

export interface FragmentCacheOptions {
  /** Prefix for the per-fragment caches. Defaults to `braid-frag`. */
  cachePrefix?: string;
  /** Cache storage to use (tests, or a worker that wraps it). Defaults to the global. */
  caches?: CacheStorage;
  /** Keep each fragment's cache in a Storage Bucket of its own where the browser has them. */
  buckets?: boolean;
  /** The bucket manager to use (tests). Defaults to `navigator.storageBuckets`. */
  storageBuckets?: StorageBucketsLike;
}

export interface StorageBucketsLike {
  open(name: string): Promise<{ caches: CacheStorage }>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<void>;
}

/** The cache a fragment's files are kept in, or undefined where there is no cache storage. */
export async function openFragmentCache(fragmentId: string, options: FragmentCacheOptions = {}): Promise<Cache | undefined> {
  const name = `${options.cachePrefix ?? DEFAULT_CACHE_PREFIX}:${fragmentId}`;
  const buckets = bucketsOf(options);
  if (buckets) {
    try {
      return await (await buckets.open(bucketFor(fragmentId, options))).caches.open(name);
    } catch {
      // refused (quota policy, an unsupported context): the shared cache storage still works
    }
  }
  return (options.caches ?? (globalThis as { caches?: CacheStorage }).caches)?.open(name);
}

/**
 * Deletes the fragment buckets this worker's prefix made, except those for `keep` (all of them when
 * null). Only names in this worker's exact format: buckets are the whole origin's, and a looser match
 * would take the realm's database buckets (`braid-db-…`), another worker's, or the app's own.
 *
 * `always` deletes even when `buckets` is off, where the API exists: sign-out must not leave a
 * previous configuration's buckets, which may hold a previous user's offline documents.
 */
export async function deleteFragmentBuckets(
  keep: readonly string[] | null,
  options: FragmentCacheOptions = {},
  { always = false }: { always?: boolean } = {},
): Promise<string[]> {
  const buckets = always ? bucketManager(options) : bucketsOf(options);
  if (!buckets) return [];
  const format = new RegExp(`^${escapeRegExp(bucketPrefix(options))}_[a-z0-9-]{1,30}_[0-9a-f]{8}$`);
  const kept = new Set((keep ?? []).map((id) => bucketFor(id, options)));
  const deleted: string[] = [];
  for (const name of await buckets.keys()) {
    if (!format.test(name) || kept.has(name)) continue;
    await buckets.delete(name);
    deleted.push(name);
  }
  return deleted;
}

/** Whether this worker keeps fragment caches in buckets: asked for, and available. */
export function usesBuckets(options: FragmentCacheOptions): boolean {
  return bucketsOf(options) !== undefined;
}

function bucketsOf(options: FragmentCacheOptions): StorageBucketsLike | undefined {
  return options.buckets ? bucketManager(options) : undefined;
}

function bucketManager(options: FragmentCacheOptions): StorageBucketsLike | undefined {
  return options.storageBuckets ?? (globalThis as { navigator?: { storageBuckets?: StorageBucketsLike } }).navigator?.storageBuckets;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A fragment's bucket name: lowercase letters, digits, `-` and `_`, at most 64 characters, as the
 * API requires. The readable part may collide once folded; the hash of the exact id keeps two
 * fragments apart.
 */
export function bucketFor(fragmentId: string, options: FragmentCacheOptions = {}): string {
  return `${bucketPrefix(options)}_${slug(fragmentId, 30)}_${fnv1a(fragmentId)}`;
}

/**
 * `braid-sw_` and the cache prefix: a namespace the realm's database buckets (`braid-db_`) never use.
 * Underscores delimit and slugs never contain one, so one prefix's names cannot be read as another's.
 */
function bucketPrefix(options: FragmentCacheOptions): string {
  return `braid-sw_${slug(options.cachePrefix ?? DEFAULT_CACHE_PREFIX, 20)}`;
}

function slug(text: string, length: number): string {
  return text.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, length) || 'x';
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
