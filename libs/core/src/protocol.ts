/**
 * Client side of the Braid composition protocol.
 *
 * These constants are deliberately duplicated in `@braidlabs/gateway/src/protocol.ts`:
 * the client and gateway bundles do not share modules, but always ship in the same package
 * version, and the protocol version below is how a mismatch is detected and reported as a
 * named error instead of a silent misbehavior.
 */

/**
 * The three reserved namespaces, one per kind of thing the gateway serves.
 *
 * They are separate paths rather than one path distinguished by request headers, so that
 * `/__braid/frag/*` — the fragment's own assets, which is nearly all the traffic — has no
 * request-header variance and caches on URL alone.
 */
export const BRAID_FRAGMENT_PREFIX = '/__braid/frag/';
export const BRAID_REALM_PREFIX = '/__braid/realm/';
export const BRAID_DOCUMENT_PREFIX = '/__braid/doc/';

/**
 * Version of the client ↔ gateway composition protocol. The gateway stamps its version onto the
 * realm stub document; the client verifies it at realm boot and fails with a named error on
 * mismatch. v2 split the single fragment namespace into frag/realm/doc.
 */
export const BRAID_PROTOCOL_VERSION = '2';

/** Name of the `<meta>` element carrying the protocol version in the realm stub document. */
export const BRAID_PROTOCOL_META = 'braid-protocol';

/** Name of the `<meta>` element carrying the fragment's manifest-declared adapter in the realm stub. */
export const BRAID_ADAPTER_META = 'braid-adapter';

/** Name of the `<meta>` carrying adapter-specific options as JSON (see the gateway's copy). */
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

/**
 * The fragment's asset namespace: what its own relative URLs resolve into.
 *
 * `basePath` is the gateway's mount (`/manage`) as `initBraid` normalized it: empty, or a path
 * with no trailing slash. The same parameter ends each builder below.
 */
export function braidFragmentUrl(fragmentId: string, pathname: string, search = '', basePath = ''): string {
  return `${basePath}${BRAID_FRAGMENT_PREFIX}${encodeURIComponent(fragmentId)}${pathname}${search}`;
}

/** The realm stub document a fragment's hidden iframe boots from. */
export function braidRealmUrl(fragmentId: string, pathname: string, search = '', basePath = ''): string {
  return `${basePath}${BRAID_REALM_PREFIX}${encodeURIComponent(fragmentId)}${pathname}${search}`;
}

/** The fragment's document, prepared by the gateway for life inside the host page's DOM. */
export function braidDocumentUrl(fragmentId: string, pathname: string, search = '', basePath = ''): string {
  return `${basePath}${BRAID_DOCUMENT_PREFIX}${encodeURIComponent(fragmentId)}${pathname}${search}`;
}
