/**
 * Gateway side of the Braid composition protocol.
 *
 * These constants are deliberately duplicated in `@braidlabs/core/src/protocol.ts`: the client
 * and gateway bundles do not share modules, but always ship in the same package version, and
 * the protocol version below is how a mismatch is detected and reported as a named error
 * instead of a silent misbehavior.
 */

/**
 * The three reserved namespaces, one per kind of thing the gateway serves.
 *
 * They are separate paths rather than one path distinguished by request headers, and that is a
 * deliberate caching decision: a URL whose response depends on a header needs that header in
 * every cache key between here and the browser, and most CDNs ignore `Vary` on anything but
 * `Accept-Encoding`. Splitting them means **`/__braid/frag/*` — the fragment's own assets, which
 * is nearly all the traffic — has no request-header variance at all** and caches on URL alone.
 */
export const BRAID_FRAGMENT_PREFIX = '/__braid/frag/';
export const BRAID_REALM_PREFIX = '/__braid/realm/';
export const BRAID_DOCUMENT_PREFIX = '/__braid/doc/';

/** @deprecated use {@link BRAID_FRAGMENT_PREFIX}; kept as the documented namespace root. */
export const BRAID_NAMESPACE_PREFIX = BRAID_FRAGMENT_PREFIX;

/**
 * Version of the client ↔ gateway composition protocol. The gateway stamps its version onto the
 * realm stub document; the client verifies it at realm boot and fails with a named
 * `BraidError { stage: 'realm-boot' }` on mismatch.
 *
 * v2 split the single fragment namespace into frag/realm/doc.
 */
/** Where the gateway serves its generated service worker, when asked to. */
export const BRAID_SERVICE_WORKER_PATH = '/__braid/sw.js';

/** The web-vitals collector, served only when telemetry's `webVitals` is on. */
export const BRAID_VITALS_SCRIPT_PATH = '/__braid/vitals.js';
/** Where that collector beacons its report. */
export const BRAID_VITALS_BEACON_PATH = '/__braid/vitals';

export const BRAID_PROTOCOL_VERSION = '2';

/** Name of the `<meta>` element carrying the protocol version in the realm stub document. */
export const BRAID_PROTOCOL_META = 'braid-protocol';

/** Name of the `<meta>` element carrying the fragment's manifest-declared adapter in the realm stub. */
export const BRAID_ADAPTER_META = 'braid-adapter';

/**
 * Name of the `<meta>` carrying adapter-specific options as JSON — the manifest fields an
 * adapter needs that mean nothing to the runtime, such as which custom element to mount.
 *
 * It rides on the realm stub for the same reason the adapter name does: the client learns
 * everything it needs about a fragment from the fragment's own registration, with no
 * client-side registry to keep in sync.
 */
export const BRAID_ADAPTER_OPTIONS_META = 'braid-adapter-options';

/** Response/request header carrying a fragment id for diagnostics. */
export const BRAID_FRAGMENT_ID_HEADER = 'x-braid-fragment-id';

/**
 * Response header on a `409` from the document namespace: where the fragment tried to send the
 * request. A browser hides the target of a redirect it was told not to follow, so the gateway
 * carries it here instead — only for fragments that opt in with `redirect: 'navigate'`.
 */
export const BRAID_REDIRECT_LOCATION_HEADER = 'x-braid-redirect-location';

/**
 * Request header on a document fetch: the page the fragment is being shown on. The gateway uses it
 * to point a login's return URL at that page instead of at the fragment's own document URL.
 */
export const BRAID_RETURN_URL_HEADER = 'x-braid-return-url';

/** What a braid-namespaced URL addresses. */
export type BraidRouteKind =
  /** The fragment's own endpoint: assets, data, anything it serves. Forwarded verbatim. */
  | 'fragment'
  /** The realm stub document the fragment's hidden iframe boots from. */
  | 'realm'
  /** The fragment's document, prepared for life inside the host page's DOM. */
  | 'document';

export interface BraidRoute {
  kind: BraidRouteKind;
  fragmentId: string;
  /** The remaining pathname, always starting with `/`. */
  pathname: string;
}

const PREFIXES: ReadonlyArray<readonly [string, BraidRouteKind]> = [
  [BRAID_FRAGMENT_PREFIX, 'fragment'],
  [BRAID_REALM_PREFIX, 'realm'],
  [BRAID_DOCUMENT_PREFIX, 'document'],
];

/**
 * Parses a braid-namespaced pathname such as `/__braid/frag/:fragmentId/rest/of/path`.
 *
 * @returns the addressed kind, decoded fragment id, and remaining pathname, or null when the
 *          path is not in any braid namespace.
 */
export function parseBraidPathname(pathname: string): BraidRoute | null {
  for (const [prefix, kind] of PREFIXES) {
    if (!pathname.startsWith(prefix)) continue;

    const rest = pathname.slice(prefix.length);
    const slashIndex = rest.indexOf('/');
    const encodedFragmentId = slashIndex === -1 ? rest : rest.slice(0, slashIndex);

    if (!encodedFragmentId) return null;

    return {
      kind,
      fragmentId: decodeURIComponent(encodedFragmentId),
      pathname: slashIndex === -1 ? '/' : rest.slice(slashIndex),
    };
  }
  return null;
}

/** @deprecated use {@link parseBraidPathname}. */
export function parseNamespacePathname(pathname: string): { fragmentId: string; pathname: string } | null {
  const route = parseBraidPathname(pathname);
  return route && route.kind === 'fragment' ? { fragmentId: route.fragmentId, pathname: route.pathname } : null;
}

/**
 * Builds a URL in the fragment's asset namespace.
 *
 * `basePath` is the gateway's mount (`/manage`), already normalized: empty, or a path with no
 * trailing slash.
 */
export function braidFragmentUrl(fragmentId: string, pathname: string, search = '', basePath = ''): string {
  return `${basePath}${BRAID_FRAGMENT_PREFIX}${encodeURIComponent(fragmentId)}${pathname}${search}`;
}
