import type { ResolvedFragmentManifest } from './registry.js';
import { BRAID_FRAGMENT_PREFIX } from './protocol.js';

/**
 * Projecting the fragment registry as an FDC3 **App Directory**.
 *
 * The registry already is one. It holds ids, titles, descriptions, tags, and — for fragments that
 * declare them — the intents each app handles and raises. It is already paginated and already
 * filtered by who is asking. AppD is a *shape*, not a second source of truth, so this is a
 * projection over the same data and the same access rules rather than a parallel service to keep
 * in sync.
 *
 * The payoff for FDC3 is direct: `findIntent` becomes a registry query, and because discovery
 * filters by the caller's principal, a user only ever sees resolvers they are permitted to use.
 *
 * Records are checked against FDC3 2.2's own AppD schema in `appd.spec.ts` (vendored under
 * `tools/fdc3/`). Optional members Braid has no data for — `lang`, `screenshots`,
 * `localizedVersions`, `interop.appChannels` — are not produced.
 */

/** The `fdc3` block a manifest may carry. A superset of what AppD needs; the rest is for the runtime. */
export interface FragmentFdc3Metadata {
  /** The FDC3 API surface this app speaks, e.g. `"2.2"`. Reserved for the runtime work. */
  apiVersion?: string;
  /** Context schema versions this app reads and writes. Reserved for the runtime work. */
  contexts?: Record<string, number>;
  /** Intents this app handles, and the context types each accepts. */
  listensFor?: Record<string, { contexts?: string[]; displayName?: string; resultType?: string }>;
  /** Intents this app raises, and the context types it raises them with. */
  raises?: Record<string, string[]>;
  /** User channel this app joins on mount. */
  defaultChannel?: string;
  /** Context types broadcast and listened for on user channels. */
  userChannels?: { broadcasts?: string[]; listensFor?: string[] };
}

/** Descriptive fields AppD carries that the registry does not otherwise need. */
export interface FragmentAppdMetadata {
  publisher?: string;
  contactEmail?: string;
  supportEmail?: string;
  moreInfo?: string;
  version?: string;
  tooltip?: string;
  icons?: { src: string; size?: string; type?: string }[];
}

/** An FDC3 AppD v2 `Application` record — the members Braid fills. */
export interface AppdApplication {
  appId: string;
  title: string;
  type: 'web';
  details: { url: string };
  description?: string;
  tooltip?: string;
  version?: string;
  categories?: string[];
  publisher?: string;
  contactEmail?: string;
  supportEmail?: string;
  moreInfo?: string;
  icons?: { src: string; size?: string; type?: string }[];
  interop?: {
    intents?: {
      listensFor?: Record<string, { displayName?: string; contexts: string[]; resultType?: string }>;
      raises?: Record<string, string[]>;
    };
    userChannels?: { broadcasts?: string[]; listensFor?: string[] };
  };
  /**
   * Braid-specific launch information.
   *
   * `hostManifests` is exactly what AppD reserves for container-specific detail, and this is the
   * honest place for it: a Braid fragment is **mounted into a page**, not opened as a window. An
   * agent that understands Braid reads this and mounts a `<fragment-slot>`; one that does not
   * falls back to `details.url` and gets something reasonable.
   */
  hostManifests: {
    braid: {
      fragmentId: string;
      /** Where the fragment is addressable — what `<fragment-slot name>` resolves to. */
      mount: string;
      adapter: string;
      /** True when `details.url` is a real page the fragment appears on rather than its mount. */
      standalonePage: boolean;
    };
  };
}

export interface AppdListResponse {
  applications: AppdApplication[];
  message: string;
}

/** AppD's error body, `ErrorDTO`. */
export interface AppdError {
  code: number;
  message: string;
}

/**
 * The App Directory's two reads over a set of manifests the caller may already see: the listing,
 * or one application by `appId`. `GET /v2/apps/{appId}` answers with the bare `Application`, not
 * a wrapper. Headers are the caller's — what may be cached differs between the gateway, whose
 * listing depends on who asked, and the registry.
 */
export function appdResponse(options: {
  manifests: readonly ResolvedFragmentManifest[];
  origin: string;
  /** Present for `/v2/apps/{appId}`, absent for the listing. */
  appId?: string;
}): { status: 200; body: AppdListResponse | AppdApplication } | { status: 404; body: AppdError } {
  const { manifests, origin, appId } = options;

  if (appId === undefined) {
    // one manifest the projection cannot read is left out, not allowed to fail everyone's listing
    const applications = manifests.flatMap((manifest) => {
      try {
        return [toAppdApplication(manifest, origin)];
      } catch {
        return [];
      }
    });
    return { status: 200, body: { applications, message: 'OK' } };
  }

  const match = manifests.find((manifest) => manifest.id === appId);
  // the same 404 for "not visible to you" as for "not registered" — distinguishing them would let
  // an unauthorized caller enumerate the registry one id at a time
  if (!match) return { status: 404, body: { code: 404, message: `No application with appId "${appId}"` } };
  return { status: 200, body: toAppdApplication(match, origin) };
}

/**
 * Projects one manifest into an AppD record.
 *
 * `details.url` is the interesting decision. AppD asks where a web app lives, and a fragment does
 * not live anywhere on its own — it appears inside a host page. So:
 *
 * - if the fragment declares `pierce`, the first pattern names a page it actually appears on, and
 *   that page *is* the answer: an operator following the link sees the app;
 * - otherwise the fragment's mount is used, which is honest but is a namespace path rather than a
 *   page, and `hostManifests.braid.standalonePage` says so.
 *
 * Either way the Braid-aware path is `hostManifests`, because "open this URL" is the wrong verb.
 */
export function toAppdApplication(manifest: ResolvedFragmentManifest, origin: string): AppdApplication {
  const mount = `${BRAID_FRAGMENT_PREFIX}${encodeURIComponent(manifest.id)}/`;
  const page = firstPiercePage(manifest.pierce);

  // `name` is deprecated in AppD v2 in favour of `appId` and `title`, so it is not set.
  const application: AppdApplication = {
    appId: manifest.id,
    title: manifest.title ?? manifest.id,
    type: 'web',
    details: { url: new URL(page ?? mount, origin).href },
    hostManifests: {
      braid: { fragmentId: manifest.id, mount, adapter: manifest.adapter, standalonePage: page !== null },
    },
  };

  if (manifest.description) application.description = manifest.description;
  if (manifest.tags?.length) application.categories = [...manifest.tags];

  const appd = manifest.appd;
  if (appd?.publisher) application.publisher = appd.publisher;
  if (appd?.contactEmail) application.contactEmail = appd.contactEmail;
  if (appd?.supportEmail) application.supportEmail = appd.supportEmail;
  const moreInfo = appd?.moreInfo ? webUrl(appd.moreInfo, origin) : null;
  if (moreInfo) application.moreInfo = moreInfo;
  if (appd?.version) application.version = appd.version;
  if (appd?.tooltip) application.tooltip = appd.tooltip;
  // AppD requires an absolute icon url; a manifest may name one relative to the shell
  const icons = (appd?.icons ?? []).flatMap((icon) => {
    const src = webUrl(icon.src, origin);
    return src ? [{ ...icon, src }] : [];
  });
  if (icons.length) application.icons = icons;

  const interop = toInterop(manifest.fdc3);
  if (interop) application.interop = interop;

  return application;
}

function toInterop(fdc3: FragmentFdc3Metadata | undefined): AppdApplication['interop'] | undefined {
  if (!fdc3) return undefined;

  const listensFor = Object.entries(fdc3.listensFor ?? {}).reduce<
    NonNullable<NonNullable<AppdApplication['interop']>['intents']>['listensFor']
  >((accumulator, [intent, declaration]) => {
    // the key is the intent's name; AppD v2's intent record has no `name` member of its own
    accumulator![intent] = {
      contexts: declaration.contexts ?? [],
      ...(declaration.displayName ? { displayName: declaration.displayName } : {}),
      ...(declaration.resultType ? { resultType: declaration.resultType } : {}),
    };
    return accumulator;
  }, {});

  const intents = {
    ...(Object.keys(listensFor ?? {}).length > 0 ? { listensFor } : {}),
    ...(fdc3.raises && Object.keys(fdc3.raises).length > 0 ? { raises: { ...fdc3.raises } } : {}),
  };

  const interop = {
    ...(Object.keys(intents).length > 0 ? { intents } : {}),
    ...(fdc3.userChannels ? { userChannels: { ...fdc3.userChannels } } : {}),
  };

  return Object.keys(interop).length > 0 ? interop : undefined;
}

/**
 * A manifest-supplied link, absolute on `origin`, or null when it is not an http(s) URL. Dropping
 * a bad one keeps one manifest's typo from failing the whole listing, and keeps `javascript:` out
 * of every launcher that renders the directory.
 */
function webUrl(value: unknown, origin: string): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The first pierce pattern reduced to a concrete page path.
 *
 * A wildcard suffix is dropped rather than filled — `/billing/*` becomes `/billing`, which is a
 * page an operator can open. A pattern with a named parameter (`/orders/:id`) names no particular
 * page, so it yields nothing rather than a link to `/orders/undefined`.
 */
function firstPiercePage(pierce: string[] | undefined): string | null {
  for (const pattern of pierce ?? []) {
    if (pattern.includes(':')) continue;
    const trimmed = pattern.replace(/\/?\*+$/, '');
    if (trimmed) return trimmed;
  }
  return null;
}
