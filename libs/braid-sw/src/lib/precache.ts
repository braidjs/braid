import { BRAID_REALM_PREFIX } from '@braidlabs/gateway';
import { openFragmentCache, type FragmentCacheOptions } from './fragment-caches.js';

/**
 * Realm stub precaching: a fragment boot with no round trip in it.
 *
 * A realm stub is the tiny document a fragment's realm is created from. They are identical per URL
 * and vary on nothing — which is what the protocol's path split bought — so they are the one thing
 * in this system that can be fetched before anybody asks for it without guessing.
 *
 * Kept deliberately small in scope: stubs only. Precaching a fragment's *application* bundles would
 * mean downloading every fragment on the origin whether or not the user ever visits a page that
 * composes them, which trades a round trip the user might make for bandwidth they certainly spend.
 */

export interface PrecacheOptions extends FragmentCacheOptions {
  fetch?: typeof fetch;
  /** Where the stubs live. Defaults to the current origin. */
  origin?: string;
}

export interface PrecacheResult {
  cached: string[];
  /** Stubs that could not be fetched, with why. A precache failure must not fail the install. */
  failed: { url: string; reason: string }[];
}

const DEFAULT_CACHE_PREFIX = 'braid-frag';

/**
 * Fetches and caches each fragment's realm stub.
 *
 * Call it from `install`, wrapped in `waitUntil`. Failures are collected rather than thrown: a
 * worker that refuses to install because one fragment's origin was briefly unreachable is worse
 * than a worker that installs and fetches that stub on demand like it used to.
 */
export async function precacheRealmStubs(
  fragmentIds: readonly string[],
  options: PrecacheOptions = {},
): Promise<PrecacheResult> {
  const cachePrefix = options.cachePrefix ?? DEFAULT_CACHE_PREFIX;
  const cacheStorage = options.caches ?? (globalThis as { caches?: CacheStorage }).caches;
  const networkFetch = options.fetch ?? globalThis.fetch;
  const origin = options.origin ?? (globalThis as { location?: { origin: string } }).location?.origin ?? '';

  const result: PrecacheResult = { cached: [], failed: [] };
  if (!cacheStorage) return result;

  for (const fragmentId of fragmentIds) {
    const url = `${origin}${BRAID_REALM_PREFIX}${fragmentId}/`;
    try {
      const response = await networkFetch(url);
      if (!response.ok) {
        result.failed.push({ url, reason: `HTTP ${response.status}` });
        continue;
      }
      const cache = await openFragmentCache(fragmentId, options);
      if (!cache) continue;
      await cache.put(url, response);
      result.cached.push(url);
    } catch (error) {
      result.failed.push({ url, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return result;
}
