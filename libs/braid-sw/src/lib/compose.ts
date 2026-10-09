import {
  BRAID_DOCUMENT_PREFIX,
  Registry,
  pierceShellHtml,
  type FragmentManifest,
  type PierceTarget,
} from '@braidlabs/gateway';

/**
 * Offline composition: the gateway's own piercing, run inside the worker.
 *
 * This falls out of decisions already made rather than needing new machinery. The gateway core is
 * runtime-neutral — no `node:` imports in the gateway, the registry, or the rewriter — and a service
 * worker is a web-standard runtime. So the worker can hold the shell and the fragment documents and
 * interleave them with the **same `pierceShellHtml` the server runs**, which matters more than the
 * code reuse: a second implementation would be a second set of piercing bugs, discovered offline.
 *
 * **Why hold the pieces rather than the composed page.** Caching the finished HTML would be simpler
 * and much less useful: the composed page is the cross-product of shell, fragments, and route, so a
 * cache of finished pages only ever answers for routes the user already visited with the fragment
 * versions they had. Holding the parts means a route visited once composes offline afterwards, and
 * a fragment that updated on its own schedule updates its part alone.
 *
 * Two things this deliberately does not do. It never composes when the network is reachable — the
 * gateway is authoritative and its answer is always preferred — and it never caches a *composed*
 * response, because a page pierced against a registry that has since changed is precisely the stale
 * artifact the rest of this package exists to avoid.
 */

export interface OfflineCompositionOptions {
  /**
   * Where the pinned registry snapshot is served from.
   *
   * Content-addressed and immutable, so it is cacheable under its id forever with no revalidation —
   * which is what makes an offline compose possible at all: piercing needs to know which fragments
   * claim this URL, and that answer must survive with no server to ask.
   */
  snapshotUrl: string;
  cachePrefix?: string;
  caches?: CacheStorage;
  fetch?: typeof fetch;
  /** Called when a page is composed offline, so a shell can say so rather than look merely slow. */
  onCompose?: (event: { pathname: string; fragmentIds: string[] }) => void;
}

const DEFAULT_CACHE_PREFIX = 'braid-frag';
const SHELL_CACHE = 'braid-shell';
const SNAPSHOT_CACHE = 'braid-snapshot';

/**
 * A navigation handler that composes from cache when the network is gone.
 *
 * ```js
 * const compose = braidNavigationHandler({ snapshotUrl: '/__braid/registry/pinned.json' });
 * self.addEventListener('activate', (event) => event.waitUntil(self.registration.navigationPreload?.enable()));
 * self.addEventListener('fetch', (event) => {
 *   const handled = compose(event.request, event.preloadResponse);
 *   if (handled) event.respondWith(handled);
 * });
 * ```
 *
 * Passing `preloadResponse` (with navigation preload enabled) means a navigation's request starts
 * while the worker is still booting, rather than after.
 */
export function braidNavigationHandler(
  options: OfflineCompositionOptions,
): (request: Request, preloadResponse?: Promise<Response | undefined>) => Promise<Response> | null {
  const cachePrefix = options.cachePrefix ?? DEFAULT_CACHE_PREFIX;
  const cacheStorage = options.caches ?? (globalThis as { caches?: CacheStorage }).caches;
  const networkFetch = options.fetch ?? globalThis.fetch;

  return (request, preloadResponse) => {
    if (request.method !== 'GET' || !isNavigation(request)) return null;
    return handle(request, preloadResponse);
  };

  async function handle(request: Request, preloadResponse?: Promise<Response | undefined>): Promise<Response> {
    try {
      // The browser already started this request while the worker booted, when preload is on.
      const response = (await preloadResponse) ?? (await networkFetch(request));
      // Kept for the next outage rather than awaited: the user is waiting on this navigation, and
      // refreshing the parts is work for a future load.
      void refresh(request).catch(() => undefined);
      return response;
    } catch (error) {
      const composed = await composeFromCache(request);
      if (composed) return composed;
      throw error;
    }
  }

  /**
   * Re-fetches the parts a compose would need: the unpierced shell, and each matching fragment's
   * prepared document.
   *
   * The shell is requested with `sec-fetch-dest: empty`, which is how the gateway distinguishes a
   * soft-navigation fetch from a document request — so it answers with the shell alone. That is not
   * a trick; it is the same distinction the `Vary` header on every pierced response already
   * declares, used from the other side.
   */
  async function refresh(request: Request): Promise<void> {
    if (!cacheStorage) return;

    const url = new URL(request.url);
    const manifests = await loadSnapshot(url.origin);
    if (!manifests) return;

    const registry = new Registry([...manifests]);
    const matches = await registry.matchPierceRoutes(url.pathname);

    const shell = await networkFetch(new Request(request.url, { headers: { 'sec-fetch-dest': 'empty' } }));
    if (shell.ok) {
      const shellCache = await cacheStorage.open(SHELL_CACHE);
      await shellCache.put(shellKey(url), shell.clone());
    }

    for (const manifest of matches) {
      const documentUrl = `${url.origin}${BRAID_DOCUMENT_PREFIX}${encodeURIComponent(manifest.id)}${documentPath(
        manifest,
        url,
      )}`;
      const response = await networkFetch(documentUrl);
      if (!response.ok) continue;

      // In the fragment's own partition, so pruning a retired fragment takes its documents too.
      const cache = await cacheStorage.open(`${cachePrefix}:${manifest.id}`);
      await cache.put(documentUrl, response.clone());
    }
  }

  async function composeFromCache(request: Request): Promise<Response | null> {
    if (!cacheStorage) return null;

    const url = new URL(request.url);
    const shellCache = await cacheStorage.open(SHELL_CACHE);
    const shell = await shellCache.match(shellKey(url));
    if (!shell?.body) return null;

    const manifests = await loadSnapshot(url.origin);
    if (!manifests) return null;

    const registry = new Registry([...manifests]);
    const matches = await registry.matchPierceRoutes(url.pathname);

    const fragments: PierceTarget[] = [];
    for (const manifest of matches) {
      const cache = await cacheStorage.open(`${cachePrefix}:${manifest.id}`);
      const documentUrl = `${url.origin}${BRAID_DOCUMENT_PREFIX}${encodeURIComponent(manifest.id)}${documentPath(
        manifest,
        url,
      )}`;
      const cached = await cache.match(documentUrl);

      // A fragment with nothing cached pierces nothing and is marked, exactly as a failed fetch is
      // server-side: the slot degrades to a placeholder rather than the page failing.
      fragments.push({
        fragmentId: manifest.id,
        content: cached?.body ?? null,
        ...(cached?.body ? {} : { fallbackReason: 'placeholder' }),
        ...(manifest.src === undefined ? {} : { src: manifest.src }),
      });
    }

    options.onCompose?.({ pathname: url.pathname, fragmentIds: matches.map((manifest) => manifest.id) });

    return new Response(pierceShellHtml({ shell: shell.body, fragments }), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Says plainly where this page came from. A composed-offline page that looks identical to a
        // served one is a page nobody can debug.
        'x-braid-composed': 'offline',
      },
    });
  }

  /** The snapshot, from cache first — offline is the case that needs it. */
  async function loadSnapshot(origin: string): Promise<readonly FragmentManifest[] | null> {
    if (!cacheStorage) return null;
    const url = new URL(options.snapshotUrl, origin).href;
    const cache = await cacheStorage.open(SNAPSHOT_CACHE);

    let response = await cache.match(url);
    if (!response) {
      try {
        const fresh = await networkFetch(url);
        if (!fresh.ok) return null;
        await cache.put(url, fresh.clone());
        response = fresh;
      } catch {
        return null;
      }
    }

    try {
      const snapshot = (await response.json()) as { manifests?: FragmentManifest[] } | FragmentManifest[];
      return Array.isArray(snapshot) ? snapshot : (snapshot.manifests ?? null);
    } catch {
      return null;
    }
  }
}

/** Unbound fragments are fetched at their own path, bound ones at the page's — as on the server. */
function documentPath(manifest: FragmentManifest, url: URL): string {
  return manifest.bound === false && manifest.src ? manifest.src : `${url.pathname}${url.search}`;
}

/** Keyed by path alone: a shell does not vary by query, and keying on one would cache N copies. */
function shellKey(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function isNavigation(request: Request): boolean {
  if (request.mode === 'navigate') return true;
  // `mode` is not always populated outside a browser; the accept header is the same signal the
  // gateway itself falls back to.
  return request.headers.get('accept')?.includes('text/html') ?? false;
}
