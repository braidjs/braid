import { braidFetchHandler, pruneFragmentCaches, type BraidFetchHandlerOptions } from './asset-handler.js';
import { braidNavigationHandler, type OfflineCompositionOptions } from './compose.js';
import { precacheRealmStubs } from './precache.js';
import { diagnoseSkew, type PageVersion, type WorkerVersion } from './skew-report.js';
import { BRAID_REPORT_SYNC_TAG, createReportQueue, type ReportQueue, type ReportQueueOptions } from './reports.js';

/**
 * The complete worker, for shells that do not already have one.
 *
 * Both shapes ship because the assumption that an application already has a service worker does not
 * hold — least of all for internal enterprise apps, which is much of the audience. A shell that has
 * a worker composes {@link braidFetchHandler} into it and keeps ownership of its own `fetch` event;
 * a shell that has none calls this and authors nothing.
 */

export interface BraidWorkerOptions extends BraidFetchHandlerOptions {
  /** Fragment ids whose realm stubs are precached at install. */
  precache?: readonly string[];
  /** The registry snapshot this worker composes against, for the skew diagnostic. */
  snapshotId?: string;
  /**
   * Take over open pages as soon as this worker activates.
   *
   * Off by default, and that default is the conservative one for a reason: claiming clients swaps
   * the worker underneath a page that is already running, so a page mid-session starts being served
   * by a build it did not load against. Waiting for the next navigation is the boring, correct
   * behaviour; turn this on when you would rather have the update than the continuity.
   */
  claimClients?: boolean;
  /**
   * Compose pages from cache when the network is gone.
   *
   * Opt-in, because it changes what a failed navigation *is*: without it an offline navigation is
   * the browser's offline page, which is at least unambiguous. With it, a route the user has
   * visited before comes back composed — so a shell turning this on should say so on the page, and
   * the `x-braid-composed: offline` header is there to make that possible.
   */
  offline?: OfflineCompositionOptions;
  /**
   * Send the worker's own reports durably, surviving a closed tab.
   *
   * Without this, `onReport` is fire-and-forget and the reports most likely to be lost are the ones
   * worth having: a user who hits a broken deploy is a user who closes the tab.
   */
  reports?: Omit<ReportQueueOptions, 'fetch'>;
}

/** The subset of the worker global this uses, so a test can supply one without a worker. */
export interface WorkerScopeLike {
  addEventListener(type: string, listener: (event: never) => void): void;
  skipWaiting?(): Promise<void>;
  clients?: { claim(): Promise<void> };
  registration?: unknown;
}

/**
 * Installs Braid's handlers on a worker scope.
 *
 * ```js
 * // sw.js
 * import { setupBraidWorker } from '@braidlabs/sw';
 * setupBraidWorker({ buildId: BUILD_ID, precache: ['billing', 'notifications'] });
 * ```
 */
export function setupBraidWorker(options: BraidWorkerOptions = {}): void {
  const scope = globalThis as unknown as {
    addEventListener(type: string, listener: (event: ExtendableFetchEvent) => void): void;
    skipWaiting?: () => Promise<void>;
    clients?: { claim(): Promise<void> };
    registration?: { navigationPreload?: { enable(): Promise<void>; disable(): Promise<void> } };
  };

  const reports: ReportQueue | null = options.reports
    ? createReportQueue({ ...options.reports, ...(options.fetch ? { fetch: options.fetch } : {}) })
    : null;

  const handler = braidFetchHandler({
    ...options,
    ...(reports
      ? {
          onReport: (report) => {
            options.onReport?.(report);
            // Queued, not sent: the send is the part that loses races with page teardown.
            void reports.record({ kind: 'asset', at: new Date().toISOString(), report });
          },
        }
      : {}),
  });
  const version: WorkerVersion = {
    ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
    ...(options.snapshotId === undefined ? {} : { snapshotId: options.snapshotId }),
  };

  scope.addEventListener('install', (event) => {
    if (!options.precache?.length) return;
    // The precache is best-effort by construction: a worker that refuses to install because one
    // fragment's origin blinked is worse than one that installs and fetches that stub on demand.
    event.waitUntil?.(
      precacheRealmStubs(options.precache, options).then((result) => {
        for (const failure of result.failed) {
          console.warn(`braid-sw: could not precache ${failure.url} — ${failure.reason}`);
        }
      }),
    );
  });

  const navigate = options.offline ? braidNavigationHandler({ ...options, ...options.offline }) : null;

  scope.addEventListener('activate', (event) => {
    const work: Promise<unknown>[] = [];
    // A worker that handles navigations sits in front of every one of them, so without this each
    // navigation waits for the worker to boot before its request even starts. Preload starts the
    // request alongside the boot. Only when this worker handles navigations: preload is a cost —
    // a duplicate request — for a worker that would let them pass, and the setting outlives the
    // worker that set it, so one deployed without `offline` turns it back off.
    const preload = scope.registration?.navigationPreload;
    if (preload) work.push((navigate ? preload.enable() : preload.disable()).catch(() => undefined));
    if (options.precache?.length) work.push(pruneFragmentCaches(options.precache, options));
    if (options.claimClients && scope.clients) work.push(scope.clients.claim());
    // Background Sync is Chromium-only, so every activation also flushes opportunistically. A
    // browser without `sync` gets this path and nothing else; one with it gets both.
    if (reports) work.push(reports.flush());
    if (work.length) event.waitUntil?.(Promise.all(work));
  });

  /**
   * The durable path: the browser wakes the worker when it judges the network is back, with no page
   * open and nothing racing teardown.
   */
  if (reports) {
    scope.addEventListener('sync', (event) => {
      if ((event as unknown as { tag?: string }).tag !== BRAID_REPORT_SYNC_TAG) return;
      event.waitUntil?.(reports.flush());
    });
  }

  scope.addEventListener('fetch', (event) => {
    // Assets first: they are the overwhelming majority, and a navigation is never one.
    const handled = handler(event.request) ?? navigate?.(event.request, event.preloadResponse);
    if (handled) event.respondWith?.(handled);
  });

  /**
   * The page introduces itself, and the worker answers with what it is.
   *
   * A page cannot read a worker's build any other way, and the mismatch this surfaces is precisely
   * the one that otherwise presents as an application bug in an application that is fine.
   */
  scope.addEventListener('message', (event) => {
    const data = event.data as { type?: string; page?: PageVersion } | undefined;
    if (data?.type !== 'braid-sw:hello') return;

    const diagnosis = diagnoseSkew(version, data.page ?? {});
    if (diagnosis.severity !== 'ok') {
      console.warn(diagnosis.message);
      void reports?.record({ kind: 'skew', at: new Date().toISOString(), diagnosis });
    }
    event.source?.postMessage?.({ type: 'braid-sw:version', diagnosis });
  });
}

/** The slice of `FetchEvent` used here — declared locally so the lib needs no DOM worker types. */
interface ExtendableFetchEvent {
  request: Request;
  data?: unknown;
  source?: { postMessage?(message: unknown): void } | null;
  respondWith?(response: Promise<Response> | Response): void;
  waitUntil?(promise: Promise<unknown>): void;
  /** The navigation's preloaded response, when navigation preload is enabled. */
  preloadResponse?: Promise<Response | undefined>;
}
