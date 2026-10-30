/**
 * @braidlabs/gateway — the Braid gateway: fetch-native origin-front middleware.
 *
 * ```ts
 * import { createGateway, toWebMiddleware } from '@braidlabs/gateway';
 *
 * const gateway = createGateway({
 *   registry: [{ id: 'legacy-billing', endpoint: 'https://billing.internal' }],
 *   // adapter defaults to 'compat' — zero fragment code required
 * });
 * ```
 *
 * Node/Connect binding: `import { toNodeMiddleware } from '@braidlabs/gateway/node'`.
 */

export { createGateway, toWebMiddleware, toFetchHandler } from './gateway.js';
export type { BraidGateway, DocumentsContext, GatewayOptions, RoutingEvent, ServiceWorkerOptions, UpgradeTarget } from './gateway.js';
export { rateVital, parseVitalsBeacon, vitalsCollectorScript } from './telemetry.js';
export { createBreaker, DEFAULT_BREAKER } from './breaker.js';
export { createSingleFlight, singleFlightKey } from './single-flight.js';
export type { SingleFlight } from './single-flight.js';
export type { Breaker, BreakerOptions, BreakerState, BreakerTransition } from './breaker.js';
export type {
  TelemetryOptions,
  TelemetryEvent,
  FragmentFetchEvent,
  WebVitalEvent,
  WebVitalName,
  BreakerEvent,
  RegistryEvent,
  FragmentFetchStart,
  FragmentFetchHooks,
} from './telemetry.js';
export { fragmentBaggage } from './baggage.js';
export type { BaggageOptions } from './baggage.js';
export {
  DEFAULT_ADAPTER,
  DEFAULT_TIMEOUT_MS,
  normalizeManifest,
  Registry,
} from './registry.js';
export type {
  FragmentManifest,
  ResolvedFragmentManifest,
  FragmentFallback,
  FragmentAccess,
  AccessRule,
  Principal,
  RegistrySource,
  RegistryRefresh,
} from './registry.js';
export { satisfies, canList, canFetch } from './registry.js';
export { DEFAULT_DISCOVERY_PATH, DEFAULT_DISCOVERY_PAGE_SIZE } from './discovery.js';
export type { DiscoveryOptions, DiscoveryEntry, DiscoveryPage } from './discovery.js';
export { appdResponse, toAppdApplication } from './appd.js';
export type {
  AppdApplication,
  AppdListResponse,
  AppdError,
  FragmentFdc3Metadata,
  FragmentAppdMetadata,
} from './appd.js';
export {
  BRAID_FRAGMENT_PREFIX,
  BRAID_REALM_PREFIX,
  BRAID_DOCUMENT_PREFIX,
  BRAID_PROTOCOL_VERSION,
  BRAID_SERVICE_WORKER_PATH,
  parseBraidPathname,
} from './protocol.js';
export type { BraidRoute, BraidRouteKind } from './protocol.js';
export { rewriteHtmlStream, concatStreams } from './rewriter/html-rewrite-stream.js';
export type { RewriteOptions, ElementHandler, StartTag, EndTag, Injection } from './rewriter/html-rewrite-stream.js';
export {
  prepareFragmentHtml,
  pierceShellHtml,
  BRAID_FRAGMENT_STYLES,
  BRAID_SHELL_STYLES,
} from './rewriter/transforms.js';
export { cspNonceOf, withNonce } from './rewriter/transforms.js';
export type { PierceOptions, PierceTarget } from './rewriter/transforms.js';
