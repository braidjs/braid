/**
 * `@braidlabs/sw` — skew-aware asset serving for composed pages.
 *
 * The classic micro-frontend white screen is a deploy landing under an open page: a lazy chunk is
 * requested, the build that wrote it is gone, and nothing on the page can recover. A service worker
 * is the only layer that can answer that request from a copy it kept — and because every fragment's
 * assets live under `/__braid/frag/:id/*`, each fragment gets its own build-keyed cache partition
 * rather than a monolith's single bucket with a single answer.
 *
 * Ships in both shapes on purpose: a handler to compose into a worker you already own, and a
 * complete worker for the (common) case where you have none.
 */

export { braidFetchHandler, pruneFragmentCaches } from './lib/asset-handler.js';
export type { BraidFetchHandlerOptions, AssetOutcome, AssetReport } from './lib/asset-handler.js';

export { setupBraidWorker } from './lib/worker.js';
export type { BraidWorkerOptions } from './lib/worker.js';

export { braidNavigationHandler, clearBraidCaches } from './lib/compose.js';
export type { OfflineCompositionOptions } from './lib/compose.js';

export { precacheRealmStubs } from './lib/precache.js';
export type { PrecacheOptions, PrecacheResult } from './lib/precache.js';

export { createReportQueue, BRAID_REPORT_SYNC_TAG } from './lib/reports.js';
export type { ReportQueue, ReportQueueOptions, BraidReport, FlushOutcome } from './lib/reports.js';

export { diagnoseSkew, BRAID_BUILD_HEADER, BRAID_SNAPSHOT_HEADER } from './lib/skew-report.js';
export type { SkewDiagnosis, SkewSeverity, WorkerVersion, PageVersion } from './lib/skew-report.js';
