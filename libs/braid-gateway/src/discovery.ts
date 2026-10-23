import { BRAID_FRAGMENT_PREFIX, BRAID_PROTOCOL_VERSION } from './protocol.js';
import { appdResponse } from './appd.js';
import { canFetch, canList, Principal, Registry, ResolvedFragmentManifest } from './registry.js';

/**
 * The discovery endpoint: a probeable, paginated listing of the fragments this gateway serves.
 *
 * It answers "what can I compose here?" for shells that build their UI from the registry rather
 * than hard-coding slot names — a launcher, an admin console, a dashboard of available apps.
 *
 * It is **off by default**. A registry lists internal service topology, so publishing it is a
 * decision, not a default.
 */

export interface DiscoveryOptions {
  /** Where to serve the listing. Defaults to `/__braid/registry`. */
  path?: string;
  /** Items per page when the caller doesn't ask. Defaults to 100. */
  pageSize?: number;
  /** Hard ceiling on `pageSize`, whatever the caller asks for. Defaults to 100. */
  maxPageSize?: number;
  /**
   * Include each fragment's `endpoint` in the listing. Defaults to false, because endpoints are
   * usually internal origins and a public listing of them is a map of your private network.
   * Forced on in development mode.
   */
  includeEndpoints?: boolean;
  /**
   * Also serve the registry in FDC3 **App Directory** shape, under `<path>/appd/v2/apps`.
   *
   * Off by default. It is a projection over the same manifests and the same `access.list` rules —
   * not a second directory — so turning it on adds a shape, never a source of truth.
   */
  appd?: boolean;
}

export interface DiscoveryEntry {
  id: string;
  title: string;
  description?: string;
  tags?: string[];
  adapter: string;
  contractVersion?: string;
  /** Where this fragment is addressable — what a `<fragment-slot name>` resolves to. */
  mount: string;
  /** Page URL patterns this fragment is server-rendered into, if any. */
  pierce?: string[];
  /**
   * Whether *this caller* may actually load the fragment.
   *
   * Listing and loading are separate rules, so a launcher can legitimately show an app the user
   * cannot open yet — this flag is what lets it render that state instead of a broken tile.
   */
  loadable: boolean;
  /**
   * Whether the fragment renders the page's route (a screen) or sits at a fixed path (a widget).
   *
   * Published because it changes how a host embeds it: a widget needs {@link DiscoveryEntry.src},
   * a screen does not. Without this a consumer has to guess, and guessing wrong is the "widget
   * renders an empty shell on every page" failure.
   */
  bound: boolean;
  /** Where an unbound fragment's content lives, as a path on its own endpoint. */
  src?: string;
  /** Present only when `includeEndpoints` is on (or in development). */
  endpoint?: string;
}

export interface DiscoveryPage {
  items: DiscoveryEntry[];
  page: number;
  pageSize: number;
  /** Total *visible* to this caller, not total registered. */
  total: number;
  totalPages: number;
  hasMore: boolean;
  protocolVersion: string;
  /** True when filtering was skipped because the gateway is in development mode. */
  unfiltered?: boolean;
}

export interface DiscoveryHandler {
  /** The listing path itself. */
  path: string;
  /** Whether this handler answers for a pathname — the listing, or its App Directory projection. */
  owns(pathname: string): boolean;
  handle(request: Request, url: URL): Promise<Response>;
}

export const DEFAULT_DISCOVERY_PATH = '/__braid/registry';
export const DEFAULT_DISCOVERY_PAGE_SIZE = 100;

/**
 * Builds the discovery handler, or null when discovery is not enabled.
 *
 * In development every fragment is listed with its endpoint regardless of `visibility`, because
 * a registry you cannot see is hard to debug — and the gateway says so loudly at startup, since
 * that is precisely the configuration you must not ship.
 */
export function createDiscoveryHandler(
  registry: Registry,
  options: DiscoveryOptions | undefined,
  mode: 'production' | 'development',
  resolvePrincipal: (request: Request) => Promise<Principal | undefined>,
): DiscoveryHandler | null {
  if (!options) return null;

  const path = options.path ?? DEFAULT_DISCOVERY_PATH;
  const maxPageSize = Math.max(1, options.maxPageSize ?? DEFAULT_DISCOVERY_PAGE_SIZE);
  const defaultPageSize = Math.min(Math.max(1, options.pageSize ?? DEFAULT_DISCOVERY_PAGE_SIZE), maxPageSize);
  const isDevelopment = mode === 'development';
  const includeEndpoints = isDevelopment || (options.includeEndpoints ?? false);

  if (isDevelopment) {
    console.warn(
      `braid-gateway: the discovery endpoint at "${path}" is running in development mode — it lists every ` +
        `fragment with its endpoint, ignoring each manifest's "access" rules. Do not ship this configuration.`,
    );
  }

  const appdEnabled = options.appd ?? false;
  const appdPath = `${path}/appd/v2/apps`;

  return {
    path,
    /** True for the discovery path and, when enabled, its App Directory projection. */
    owns(pathname: string): boolean {
      return pathname === path || (appdEnabled && (pathname === appdPath || pathname.startsWith(`${appdPath}/`)));
    },

    async handle(request: Request, url: URL): Promise<Response> {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ error: 'method not allowed' }, 405, { Allow: 'GET, HEAD' });
      }

      const principal = isDevelopment ? undefined : await resolvePrincipal(request);
      const all = await registry.listFragments();
      const visible = isDevelopment ? all : all.filter((manifest) => canList(manifest, principal));

      // The App Directory is the same list, in AppD's shape — same manifests, same access rules,
      // so a caller can never see a resolver through AppD that discovery would have hidden.
      if (appdEnabled && url.pathname.startsWith(appdPath)) {
        const requested = url.pathname.slice(appdPath.length).replace(/^\//, '');
        const { status, body } = appdResponse({
          manifests: visible,
          origin: url.origin,
          ...(requested ? { appId: safeDecode(requested) } : {}),
        });
        return json(body, status, {
          'Cache-Control': 'no-store',
          ...(status === 200 ? { Vary: 'cookie, authorization' } : {}),
        });
      }

      const pageSize = clampPageSize(url.searchParams.get('pageSize'), defaultPageSize, maxPageSize);
      const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
      const page = clampPage(url.searchParams.get('page'), totalPages);

      const start = (page - 1) * pageSize;
      const items = visible
        .slice(start, start + pageSize)
        .map((manifest) => toEntry(manifest, includeEndpoints, isDevelopment || canFetch(manifest, principal)));

      const body: DiscoveryPage = {
        items,
        page,
        pageSize,
        total: visible.length,
        totalPages,
        hasMore: start + items.length < visible.length,
        protocolVersion: BRAID_PROTOCOL_VERSION,
        ...(isDevelopment ? { unfiltered: true } : {}),
      };

      // the listing depends on who asked, so it must never land in a shared cache
      return json(body, 200, {
        'Cache-Control': 'no-store',
        Vary: 'cookie, authorization',
      });
    },
  };
}

function toEntry(
  manifest: ResolvedFragmentManifest,
  includeEndpoints: boolean,
  loadable: boolean,
): DiscoveryEntry {
  const entry: DiscoveryEntry = {
    id: manifest.id,
    title: manifest.title ?? manifest.id,
    adapter: manifest.adapter,
    mount: `${BRAID_FRAGMENT_PREFIX}${encodeURIComponent(manifest.id)}/`,
    loadable,
    bound: manifest.bound,
  };

  if (manifest.description) entry.description = manifest.description;
  if (manifest.tags?.length) entry.tags = [...manifest.tags];
  if (manifest.contractVersion) entry.contractVersion = manifest.contractVersion;
  if (manifest.pierce?.length) entry.pierce = [...manifest.pierce];
  if (manifest.src) entry.src = manifest.src;
  if (includeEndpoints && typeof manifest.endpoint === 'string') entry.endpoint = manifest.endpoint;

  return entry;
}

function clampPageSize(requested: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(requested ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function clampPage(requested: string | null, totalPages: number): number {
  const parsed = Number.parseInt(requested ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, totalPages);
}

/** A malformed escape names no application, rather than throwing. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', ...headers },
  });
}
