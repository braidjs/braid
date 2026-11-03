import { parseBraidPathname } from '@braidlabs/gateway';
import { DEFAULT_CACHE_PREFIX, deleteFragmentBuckets, openFragmentCache, type FragmentCacheOptions } from './fragment-caches.js';

/**
 * Skew-aware asset serving: the one layer that can keep an open page working after a deploy.
 *
 * The failure this exists for is the classic micro-frontend white screen. A user has the page open,
 * a deploy lands, they click something that lazy-loads `main.abc123.js` — and it is gone from the
 * origin, because the new build wrote `main.def456.js` instead. Nothing on the page can recover:
 * the request is made by the module loader, the response is a 404, and the route dies.
 *
 * A service worker can, because it saw that chunk go past on the way in and kept a copy.
 *
 * **Braid makes this materially cleaner than it is for a monolith.** Every fragment's assets live
 * under `/__braid/frag/:id/*`, so each fragment gets its own cache partition keyed by its own build.
 * Fragment A at build 5 and fragment B at build 12 coexist with no shared cache generation to
 * invalidate — a monolith's worker has one bucket and one answer for the whole page.
 *
 * Scope discipline: this handler answers for the Braid namespace and returns `null` for everything
 * else. A shell composing it into its own worker keeps ownership of its own routes, and a shell
 * using the prebuilt worker gets a worker that does nothing surprising to the rest of its origin.
 */

/** How a request was answered — the input to the diagnostics a silent worker would deny you. */
export type AssetOutcome =
  | 'network'
  | 'cache'
  /** Served from cache *after* the network said the asset is gone — the deploy-skew save. */
  | 'cache-after-404'
  | 'offline';

export interface AssetReport {
  fragmentId: string;
  url: string;
  outcome: AssetOutcome;
  /** The cache partition that answered, or would have. */
  partition: string;
}

export interface BraidFetchHandlerOptions extends FragmentCacheOptions {
  /**
   * The build this worker was shipped as.
   *
   * A worker is itself a long-lived deployment artifact that updates on its own schedule, so it is
   * a skew vector in a system whose purpose is managing them. Naming its build is what lets a
   * disagreement be reported instead of silently serving yesterday's assets to today's document.
   */
  buildId?: string;
  /** Cache name prefix. One cache per fragment, so eviction is per fragment too. */
  cachePrefix?: string;
  /** Called for every namespace request this handler answers. Wire it to your telemetry. */
  onReport?: (report: AssetReport) => void;
  /** Injectable for tests. Defaults to the worker's own `caches`. */
  caches?: CacheStorage;
  /** Injectable for tests. Defaults to the worker's own `fetch`. */
  fetch?: typeof fetch;
}


/**
 * Builds a fetch handler for the Braid namespace.
 *
 * ```js
 * const braid = braidFetchHandler();
 * self.addEventListener('fetch', (event) => {
 *   const handled = braid(event.request);   // null for anything not ours
 *   if (handled) event.respondWith(handled);
 * });
 * ```
 */
export function braidFetchHandler(
  options: BraidFetchHandlerOptions = {},
): (request: Request) => Promise<Response> | null {
  const cachePrefix = options.cachePrefix ?? DEFAULT_CACHE_PREFIX;
  const networkFetch = options.fetch ?? globalThis.fetch;

  return (request: Request) => {
    // GET only. A cache cannot answer a POST, and pretending otherwise is how a worker turns a
    // failed write into a stale success.
    if (request.method !== 'GET') return null;

    const url = new URL(request.url);
    const route = parseBraidPathname(url.pathname);

    // Assets and realm stubs only. A fragment *document* is composed markup whose freshness is the
    // gateway's business — caching one here would serve a page built against a registry that has
    // since changed, which is the failure this package exists to prevent rather than cause.
    if (!route || (route.kind !== 'fragment' && route.kind !== 'realm')) return null;

    return serve(request, url, route.fragmentId);
  };

  async function serve(request: Request, url: URL, fragmentId: string): Promise<Response> {
    const partition = `${cachePrefix}:${fragmentId}`;
    const report = (outcome: AssetOutcome) =>
      options.onReport?.({ fragmentId, url: url.href, outcome, partition });

    const cache = await openFragmentCache(fragmentId, options);

    try {
      const response = await networkFetch(request);

      // 404 is the deploy case, and the only status worth reaching into the cache for. A 500 is the
      // server having a bad moment about an asset that still exists; answering it from cache would
      // paper over an outage and make it someone else's mystery.
      if (response.status === 404) {
        const cached = await cache?.match(request);
        if (cached) {
          report('cache-after-404');
          return cached;
        }
      }

      // Only successful, non-partial responses are worth keeping. A cached 206 answers a range
      // request that was never asked for.
      if (response.ok && response.status === 200 && cache) {
        // Cached without awaiting: the page is waiting on this response, and the copy is an
        // optimization for a future load rather than a precondition for this one.
        void cache.put(request, response.clone()).catch(() => undefined);
      }

      report('network');
      return response;
    } catch (error) {
      // The network is gone, not merely unhappy. This is the offline path.
      const cached = await cache?.match(request);
      if (cached) {
        report('offline');
        return cached;
      }
      throw error;
    }
  }
}

/**
 * Removes cache partitions for fragments that are no longer registered.
 *
 * Per fragment rather than per build: a fragment's own chunks are content-hashed, so its partition
 * grows by a bounded amount per deploy and shrinking it on activate would throw away exactly the
 * old chunks this handler exists to keep. A fragment that has left the registry, on the other hand,
 * is never coming back for them.
 */
export async function pruneFragmentCaches(
  keep: readonly string[],
  options: FragmentCacheOptions = {},
): Promise<string[]> {
  const cachePrefix = options.cachePrefix ?? DEFAULT_CACHE_PREFIX;
  const cacheStorage = options.caches ?? (globalThis as { caches?: CacheStorage }).caches;
  const kept = new Set(keep.map((id) => `${cachePrefix}:${id}`));
  const removed: string[] = [];

  // the shared cache storage first: with buckets on, this is also where a worker that just
  // switched left its old per-fragment caches
  for (const name of (await cacheStorage?.keys()) ?? []) {
    if (!name.startsWith(`${cachePrefix}:`) || kept.has(name)) continue;
    await cacheStorage!.delete(name);
    removed.push(name);
  }
  removed.push(...(await deleteFragmentBuckets(keep, options)));

  return removed;
}
