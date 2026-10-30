/**
 * Registry & manifests: the registry is data, not code. Fragments register via manifest
 * documents; deploying a fragment never redeploys the gateway.
 */

/** How a fragment failure surfaces in a composed page. */
export type FragmentFallback = 'omit' | 'placeholder' | 'error-html';

/**
 * `braid.manifest.json` — one per fragment.
 */
import type { FragmentAppdMetadata, FragmentFdc3Metadata } from './appd.js';

export interface FragmentManifest {
  /** Unique fragment id; addresses the fragment in the reserved namespace (`/__braid/frag/:id/*`). */
  id: string;
  /**
   * The endpoint of the fragment application: a base URL, or a `fetch`-compatible function.
   * Namespace requests are forwarded here with the namespace prefix stripped, so the endpoint
   * sees the same paths it would serve standalone.
   */
  endpoint: string | typeof fetch;
  /**
   * The adapter the fragment runs under in the client. Defaults to `"compat"` — the contained
   * web-fragments-style emulation layer — so legacy apps compose with zero app-code changes.
   */
  adapter?: string;
  /** Contract version for contract-mode fragments (unused by the compat adapter). */
  contractVersion?: string;
  /**
   * What this fragment requires of a host, and what it provides back.
   *
   * Compared at the boundary handshake, before any state crosses. Recorded here rather than taken
   * only from the fragment's own ACCEPT because the registry is host-side configuration: on the
   * untrusted tier a fragment stating its own requirements could state them away.
   *
   * ```jsonc
   * "contract": {
   *   "version": "2.1.0",
   *   "requires": { "host": ">=1.4.0", "context": { "cart": 2 } },
   *   "provides": { "events": ["checkout:complete"] }
   * }
   * ```
   */
  contract?: {
    version: string;
    requires?: { host?: string; context?: Record<string, number> };
    provides?: { events?: string[]; actions?: string[] };
  };
  /**
   * What this fragment is allowed to do. Host-owned: never describable by the fragment itself,
   * because a grant a fragment can widen is not a grant.
   *
   * ```jsonc
   * "capabilities": {
   *   "context": { "read": ["user", "cart"] },
   *   "sandbox": ["allow-popups"],
   *   "permissions": ["clipboard-write"]
   * }
   * ```
   */
  capabilities?: {
    context?: { read?: string[]; write?: string[] };
    sandbox?: string[];
    permissions?: string[];
    network?: string[];
    /**
     * Whose Web Storage this trusted (compat) fragment sees: the host origin's (`'shared'`, the
     * default), its own (`'partitioned'`), or a store shared by name (`{ partition: 'kcd' }`).
     */
    storage?: 'partitioned' | 'shared' | { partition: string };
    /** Host globals this trusted fragment shares; replaces the host's `initBraid` default. */
    sharedGlobals?: string[];
  };
  /**
   * Mount prerequisites this fragment needs before its code runs — keys the host resolves with
   * `initBraid({ prerequisites })`, such as `session:orders` for a warm session on the fragment's
   * authorization server. Stamped onto the realm stub.
   */
  requires?: string[];
  /** Module entry for contract-mode fragments (unused by the compat adapter). */
  entry?: string;
  /**
   * For the `custom-element` adapter: the tag name the fragment's entry module defines.
   *
   * The fragment ships an ordinary custom element and knows nothing about Braid; this is how
   * the gateway tells the client what to mount.
   */
  element?: string;
  /**
   * Route-pattern sugar: the page URLs whose server-rendered HTML this fragment is pierced
   * into. Patterns are URLPattern pathname syntax (`/checkout/*`, `/orders/:id`).
   *
   * This is *only* the "which page URLs pierce which fragment" mapping — it is never the
   * mechanism for asset or data routing, which is always exact and id-addressed.
   */
  pierce?: string[];
  /**
   * Whether this fragment renders the page's route.
   *
   * Defaults to `true`: a bound fragment is a screen, so it is fetched at the page's own path and
   * participates in host navigation. `false` marks a widget — header chrome, a sidebar, a global
   * search box — whose content lives at one fixed path regardless of which page it appears on.
   */
  bound?: boolean;
  /**
   * Where an unbound fragment's content lives, as a path on its own endpoint (`/panel`).
   *
   * Required in practice for `bound: false`, because the alternative is asking a notifications
   * endpoint for `/billing/invoices` — a request that means nothing to it and that will, at best,
   * 404 on every page the widget appears on.
   */
  src?: string;
  /**
   * Where a bound fragment's document lives, as a path on its own endpoint (`/index.html`).
   *
   * For a single-page app on a static origin — a bucket behind a CDN — that has one document and
   * 404s every route. Without it, a deep link asks that origin for `/accounts/123`. The fragment's
   * router still sees the page's real route; only the request for its document changes. Assets
   * are unaffected and are always fetched at their own paths.
   */
  documentPath?: string;
  /** Typed event surface for hosts. Reserved; not enforced by this build. */
  events?: Record<string, { detail: string }>;
  /** Per-fragment budget for endpoint fetches, in milliseconds. */
  timeoutMs?: number;
  /**
   * What the page stream does when it reaches this fragment's slot before the fragment has answered.
   *
   * `in-order` (the default) waits there, up to `timeoutMs`, so everything after the slot waits too.
   * `out-of-order` streams on past the empty slot and sends the fragment's markup at the end of the
   * document once it arrives; the client moves it into the slot. A fragment whose response headers
   * are in by the time its slot streams, or a turn of the event loop later, is inlined either way,
   * so the slot shifts layout only when waiting would have held up the page. Reserve the slot's
   * space in host CSS to keep that shift at zero, and keep the fragment holding the page's largest
   * content in-order.
   */
  stream?: 'in-order' | 'out-of-order';
  /**
   * Opt this fragment out of concurrent-fetch coalescing. Defaults to `true` (coalesced).
   *
   * The gateway only shares a fetch between requests whose `cookie`, `authorization`, `user-agent`,
   * and negotiation headers match, which covers how endpoints normally vary. Set this to `false`
   * when yours varies on something the gateway cannot see — a tenant header, a feature-flag
   * header, anything bespoke — because two such requests would otherwise look identical to it and
   * share one render.
   */
  coalesce?: boolean;
  /**
   * What the gateway renders into the slot when this fragment can't be server-rendered.
   *
   * - `placeholder` (default) — the slot is left empty and marked `data-braid-fallback`, so the
   *   page can style a skeleton. The client runtime then fetches the fragment itself, which
   *   means a transient SSR failure self-heals instead of becoming a visible error.
   * - `omit` — same, without the marker attribute.
   * - `error-html` — the gateway renders an error into the slot. Choose this only when a
   *   missing section is worse than a visible failure.
   */
  fallback?: FragmentFallback;
  /** Compat-specific options. */
  compat?: {
    fidelity?: 'documented';
    warnOnUnaudited?: boolean;
  };

  /** Human-readable name for discovery listings. Defaults to the id. */
  title?: string;
  /** One-line description for discovery listings. */
  description?: string;
  /** Free-form labels for filtering and grouping in discovery listings. */
  tags?: string[];

  /**
   * FDC3 metadata: the intents this app handles and raises, and the channels it uses.
   *
   * Projected into the App Directory listing (see `appd.ts`). The runtime members —
   * `apiVersion`, `contexts` — are reserved for the FDC3 work and unused by the gateway.
   */
  fdc3?: FragmentFdc3Metadata;
  /**
   * Descriptive fields the App Directory carries that the registry does not otherwise need —
   * publisher, contact addresses, icons. Purely for listings.
   */
  appd?: FragmentAppdMetadata;

  /**
   * Who may list this fragment, and who may load it. Declared at registration, so a
   * fragment's own team decides its exposure rather than every host re-deciding it.
   *
   * **Both are public by default.** Omit `access` entirely and anyone can discover and load the
   * fragment; add only the rule you need. The two are independent: a fragment can be openly
   * listed but restricted to load (visible in a launcher, gated on click), or loadable by anyone
   * holding a deep link but kept out of listings.
   */
  access?: FragmentAccess;

  /**
   * What happens when the fragment answers its document request with a redirect — almost always an
   * unauthenticated request being sent to a login page.
   *
   * - `'error'` (default) — the client reports a named `fragment-fetch` error. A browser hides where
   *   a redirect it was told not to follow was going, so nothing more is possible without an opt-in.
   * - `'navigate'` — the gateway hands the target to the client, which navigates the whole page
   *   there, exactly as the shell would have done had the redirect hit the top-level request.
   *
   * Opt-in because it lets the fragment's endpoint move the top-level page. The target must be on
   * the host's origin, inside the fragment's own endpoint path, or on an origin listed in the
   * gateway's `redirectOrigins`; anything else is refused. It only works end to end once the
   * fragment can see who the user is (`forwardCredentials` or `additionalHeaders`) — otherwise it
   * redirects again on the way back, and the client stops after one round trip.
   */
  redirect?: 'error' | 'navigate';
}

export interface FragmentAccess {
  /** Who may see this fragment in the discovery registry. Public when omitted. */
  list?: AccessRule;
  /** Who may load this fragment through the namespace, or have it pierced in. Public when omitted. */
  fetch?: AccessRule;
}

export interface AccessRule {
  /** The caller must hold **at least one** of these roles. */
  roles?: string[];
  /** The caller must hold **all** of these scopes. */
  scopes?: string[];
}

/** Who is asking, as resolved from a request by the gateway's host application. */
export interface Principal {
  roles?: readonly string[];
  scopes?: readonly string[];
}

/**
 * Whether a principal satisfies an access rule.
 *
 * Note the deliberate asymmetry, which matches how these are normally used: **roles are any-of**
 * (holding one of `["finance", "admin"]` is enough), while **scopes are all-of** (an operation
 * requiring `["billing:read", "billing:list"]` needs both).
 */
export function satisfies(rule: AccessRule | undefined, principal: Principal | undefined): boolean {
  if (!rule) return true;

  const roles = new Set(principal?.roles ?? []);
  const scopes = new Set(principal?.scopes ?? []);

  if (rule.roles?.length && !rule.roles.some((role) => roles.has(role))) return false;
  if (rule.scopes?.length && !rule.scopes.every((scope) => scopes.has(scope))) return false;
  return true;
}

/** Whether this fragment appears in discovery listings for the given caller. */
export function canList(manifest: ResolvedFragmentManifest, principal: Principal | undefined): boolean {
  return satisfies(manifest.access?.list, principal);
}

/** Whether this caller may load the fragment — through the namespace or by piercing. */
export function canFetch(manifest: ResolvedFragmentManifest, principal: Principal | undefined): boolean {
  return satisfies(manifest.access?.fetch, principal);
}

/** Whether a manifest restricts anything at all, so the gateway can skip resolving a principal. */
export function hasAccessRules(manifest: ResolvedFragmentManifest): boolean {
  return Boolean(manifest.access?.list || manifest.access?.fetch);
}

/** A manifest with all defaults applied. */
export interface ResolvedFragmentManifest extends FragmentManifest {
  adapter: string;
  timeoutMs: number;
  fallback: FragmentFallback;
  bound: boolean;
}

/**
 * The adapter used when a manifest doesn't declare one. This build ships only the compat
 * adapter, and makes it the default.
 */
export const DEFAULT_ADAPTER = 'compat';

export const DEFAULT_TIMEOUT_MS = 1500;

/**
 * A registry source: inline manifests, a URL to a JSON document (an array of manifests), or an
 * async loader for anything else (file, KV, database).
 */
export type RegistrySource = FragmentManifest[] | string | (() => Promise<FragmentManifest[]>);

export function normalizeManifest(manifest: FragmentManifest): ResolvedFragmentManifest {
  if (!manifest.id || manifest.id.includes('/')) {
    throw new Error(
      `braid-gateway: manifest id "${manifest.id}" is invalid — ids must be non-empty and must not contain "/"`,
    );
  }
  if (!manifest.endpoint) {
    throw new Error(`braid-gateway: manifest "${manifest.id}" is missing its endpoint`);
  }
  if (manifest.documentPath !== undefined && !isPlainPath(manifest.documentPath)) {
    throw new Error(
      `braid-gateway: manifest "${manifest.id}" has documentPath "${manifest.documentPath}" — it must be ` +
        `a plain path on the fragment's endpoint, e.g. documentPath: "/index.html" (no "//", "\\", ` +
        `dot segments, query, or fragment)`,
    );
  }

  // Warned rather than thrown: the fragment still composes, at the page path, which is wrong in a
  // way that shows up as an empty widget rather than as an error anyone can trace back to here.
  if (manifest.bound === false && !manifest.src) {
    console.warn(
      `braid-gateway: fragment "${manifest.id}" declares bound: false without a src, so it will be ` +
        `fetched at each page's own path — declare the path its content lives at, e.g. src: "/panel"`,
    );
  }

  if (
    manifest.requires !== undefined &&
    (!Array.isArray(manifest.requires) || manifest.requires.some((key) => typeof key !== 'string' || key.trim() === ''))
  ) {
    throw new Error(`braid-gateway: manifest "${manifest.id}" has a requires that is not a list of non-empty keys`);
  }
  if (manifest.stream !== undefined && manifest.stream !== 'in-order' && manifest.stream !== 'out-of-order') {
    throw new Error(
      `braid-gateway: manifest "${manifest.id}" declares stream: "${String(manifest.stream)}" — ` +
        `use "in-order" or "out-of-order"`,
    );
  }
  if (manifest.redirect !== undefined && manifest.redirect !== 'error' && manifest.redirect !== 'navigate') {
    throw new Error(
      `braid-gateway: manifest "${manifest.id}" declares redirect: "${String(manifest.redirect)}" — ` +
        `use "error" or "navigate"`,
    );
  }

  return {
    ...manifest,
    adapter: manifest.adapter ?? DEFAULT_ADAPTER,
    timeoutMs: manifest.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fallback: manifest.fallback ?? 'placeholder',
    bound: manifest.bound ?? true,
  };
}

/**
 * An absolute path that means the same thing however it is joined onto an endpoint: one leading
 * slash, no backslashes (which URL parsers treat as slashes), no dot segments, no query or hash.
 */
function isPlainPath(path: string): boolean {
  return /^\/(?!\/)[^?#\\]*$/.test(path) && !path.split('/').some((segment) => segment === '.' || segment === '..');
}

/** A fragment's `pierce` pattern, compiled for matching. */
interface CompiledPierceRoute {
  manifest: ResolvedFragmentManifest;
  matches(pathname: string): boolean;
}

/** What a refresh changed, so the gateway can reset per-fragment state that no longer applies. */
export interface RegistryRefresh {
  /** False when the source returned the very manifests already being served. */
  changed: boolean;
  fragmentCount: number;
  /** Fragments no longer registered. */
  removed: string[];
  /** Fragments still registered whose endpoint is different now. */
  endpointChanged: string[];
}

/** One loaded registry: manifests and the routes compiled from them, always replaced together. */
interface RegistryState {
  /** What the source returned, kept to tell an unchanged reload from a new one cheaply. */
  raw: readonly FragmentManifest[];
  /**
   * The manifests as JSON, for sources that return a new array with the same content on every
   * load — a URL, or a loader with no memo. Comparing this before compiling is what keeps an
   * unchanged poll from recompiling every pattern and announcing a change that did not happen.
   */
  fingerprint: string;
  manifests: Map<string, ResolvedFragmentManifest>;
  pierceRoutes: CompiledPierceRoute[];
}

export class Registry {
  #source: RegistrySource;
  #state: RegistryState | undefined;
  /** The first load, shared by every request that arrives before it finishes. */
  #loading: Promise<RegistryState> | undefined;
  /** A refresh in flight, shared by every caller that asks for one meanwhile. */
  #refreshing: Promise<RegistryRefresh> | undefined;

  constructor(source: RegistrySource) {
    this.#source = source;
    if (Array.isArray(source)) {
      // inline manifests fail fast at construction
      this.#state = compileState(source);
    }
  }

  /** Whether the source can return something different on a later load. Inline manifests cannot. */
  get refreshable(): boolean {
    return !Array.isArray(this.#source);
  }

  /** The manifests as the source returned them, for the registry being served now. */
  async current(): Promise<readonly FragmentManifest[]> {
    return (await this.#load()).raw;
  }

  async getFragment(fragmentId: string): Promise<ResolvedFragmentManifest | undefined> {
    const { manifests } = await this.#load();
    return manifests.get(fragmentId);
  }

  /**
   * Returns every fragment whose `pierce` patterns cover this page path, in registration order.
   *
   * A page may compose several independently deployed fragments; each is pierced into the slot
   * that names it.
   */
  async matchPierceRoutes(pathname: string): Promise<ResolvedFragmentManifest[]> {
    // One state for the whole match: a refresh landing mid-loop cannot mix two registries.
    const { pierceRoutes } = await this.#load();

    // Deduplicated by fragment. Routes are compiled one per *pattern*, so a fragment declaring
    // both `/billing` and `/billing/*` matches `/billing` twice — the second through the
    // trailing-slash tolerance. Returning it twice would fetch that fragment twice per page load
    // and pierce two copies of it into one slot; callers want the set of fragments that match,
    // not the set of patterns that did.
    const matched = new Map<string, ResolvedFragmentManifest>();
    for (const route of pierceRoutes) {
      if (route.matches(pathname) && !matched.has(route.manifest.id)) {
        matched.set(route.manifest.id, route.manifest);
      }
    }
    return [...matched.values()];
  }

  /** Every registered fragment, ordered by id so pagination is deterministic. */
  async listFragments(): Promise<ResolvedFragmentManifest[]> {
    const { manifests } = await this.#load();
    return [...manifests.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * Loads the source again and, if it returned something new, swaps it in.
   *
   * All or nothing: the new manifests are normalized and their routes compiled before anything is
   * replaced, and the replacement is one assignment, so a request sees one registry or the other,
   * never parts of both. A source that throws, or returns a registry that does not compile, leaves
   * the current one serving — the error is the caller's to report, not the next request's to fail.
   */
  refresh(): Promise<RegistryRefresh> {
    this.#refreshing ??= this.#reload().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #reload(): Promise<RegistryRefresh> {
    const unchanged = (state: RegistryState): RegistryRefresh => ({
      changed: false,
      fragmentCount: state.manifests.size,
      removed: [],
      endpointChanged: [],
    });

    // Nothing loaded yet: this *is* the first load, not a change to one.
    if (!this.#state) return unchanged(await this.#load());

    const previous = this.#state;
    const raw = await loadSource(this.#source);
    if (raw === previous.raw) return unchanged(previous);
    if (JSON.stringify(raw) === previous.fingerprint) {
      // Same manifests, new array — a snapshot that changed only its shells, say. Nothing to
      // recompile, but adopt the array: it is how the source tells which snapshot is being served.
      this.#state = { ...previous, raw };
      return unchanged(this.#state);
    }

    const next = compileState(raw);
    this.#state = next;

    const removed: string[] = [];
    const endpointChanged: string[] = [];
    for (const [id, manifest] of previous.manifests) {
      const now = next.manifests.get(id);
      if (!now) removed.push(id);
      else if (now.endpoint !== manifest.endpoint) endpointChanged.push(id);
    }
    return { changed: true, fragmentCount: next.manifests.size, removed, endpointChanged };
  }

  #load(): Promise<RegistryState> {
    if (this.#state) return Promise.resolve(this.#state);
    // A failed first load is not cached: the next request tries again.
    this.#loading ??= loadSource(this.#source)
      .then((raw) => (this.#state = compileState(raw)))
      .finally(() => {
        this.#loading = undefined;
      });
    return this.#loading;
  }
}

async function loadSource(source: RegistrySource): Promise<readonly FragmentManifest[]> {
  if (typeof source === 'function') return source();
  if (typeof source === 'string') {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`braid-gateway: loading the registry from "${source}" failed with HTTP ${response.status}`);
    }
    return (await response.json()) as FragmentManifest[];
  }
  return source;
}

function compileState(raw: readonly FragmentManifest[]): RegistryState {
  const manifests = indexManifests(raw);
  return { raw, fingerprint: JSON.stringify(raw), manifests, pierceRoutes: compilePierceRoutes(manifests) };
}

/**
 * Compiles every manifest's `pierce` patterns with the standard URLPattern API (global since
 * Node 23.8, and native on Workers/Deno). An invalid pattern is a registration error, not a
 * silently-never-matching route.
 */
function compilePierceRoutes(manifests: Map<string, ResolvedFragmentManifest>): CompiledPierceRoute[] {
  const routes: CompiledPierceRoute[] = [];

  const piercing = [...manifests.values()].some((manifest) => (manifest.pierce ?? []).length > 0);
  if (piercing) assertURLPatternAvailable();

  for (const manifest of manifests.values()) {
    for (const pathnamePattern of manifest.pierce ?? []) {
      let pattern: URLPattern;
      try {
        pattern = new URLPattern({ pathname: pathnamePattern });
      } catch (cause) {
        throw new Error(
          `braid-gateway: fragment "${manifest.id}" declares an invalid pierce pattern "${pathnamePattern}" — ` +
            `patterns use URLPattern pathname syntax (https://developer.mozilla.org/docs/Web/API/URL_Pattern_API)`,
          { cause },
        );
      }

      routes.push({
        manifest,
        matches(pathname: string) {
          if (pattern.test({ pathname })) return true;
          // URLPattern is strict about trailing slashes (`/checkout/*` does not match
          // `/checkout`); page routes are conventionally slash-insensitive, so try both forms
          const toggled = pathname.endsWith('/') ? pathname.slice(0, -1) : `${pathname}/`;
          return toggled !== '' && pattern.test({ pathname: toggled });
        },
      });
    }
  }

  return routes;
}

/**
 * `URLPattern` is a global only from Node 23.8; on older runtimes the constructor throws a
 * ReferenceError. Left to the per-pattern try/catch below that reads as "your pattern is invalid"
 * for every pattern in the registry, which sends you debugging the manifest instead of the runtime.
 */
function assertURLPatternAvailable(): void {
  if (typeof URLPattern !== 'undefined') return;

  const node = typeof process !== 'undefined' && process.versions?.node ? ` (running Node ${process.versions.node})` : '';
  throw new Error(
    `braid-gateway: this runtime has no global URLPattern${node}, which pierce patterns require — ` +
      `use Node 24 or newer (URLPattern is global from Node 23.8), or a runtime that implements the ` +
      `URL Pattern API (Workers, Deno, modern browsers)`,
  );
}

function indexManifests(manifests: readonly FragmentManifest[]): Map<string, ResolvedFragmentManifest> {
  const indexed = new Map<string, ResolvedFragmentManifest>();
  for (const manifest of manifests) {
    const resolved = normalizeManifest(manifest);
    if (indexed.has(resolved.id)) {
      console.warn(`braid-gateway: duplicate manifest for fragment id "${resolved.id}" — ignoring the duplicate`);
      continue;
    }
    indexed.set(resolved.id, resolved);
  }
  return indexed;
}
