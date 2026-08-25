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
    storage?: 'partitioned' | 'shared';
  };
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
  /** Typed event surface for hosts. Reserved; not enforced by this build. */
  events?: Record<string, { detail: string }>;
  /** Per-fragment budget for endpoint fetches, in milliseconds. */
  timeoutMs?: number;
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

  // Warned rather than thrown: the fragment still composes, at the page path, which is wrong in a
  // way that shows up as an empty widget rather than as an error anyone can trace back to here.
  if (manifest.bound === false && !manifest.src) {
    console.warn(
      `braid-gateway: fragment "${manifest.id}" declares bound: false without a src, so it will be ` +
        `fetched at each page's own path — declare the path its content lives at, e.g. src: "/panel"`,
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

/** A fragment's `pierce` pattern, compiled for matching. */
interface CompiledPierceRoute {
  manifest: ResolvedFragmentManifest;
  matches(pathname: string): boolean;
}

export class Registry {
  #source: RegistrySource;
  #manifests: Map<string, ResolvedFragmentManifest> | undefined;
  #pierceRoutes: CompiledPierceRoute[] | undefined;

  constructor(source: RegistrySource) {
    this.#source = source;
    if (Array.isArray(source)) {
      // inline manifests fail fast at construction
      this.#manifests = indexManifests(source);
      this.#pierceRoutes = compilePierceRoutes(this.#manifests);
    }
  }

  async getFragment(fragmentId: string): Promise<ResolvedFragmentManifest | undefined> {
    const manifests = await this.#load();
    return manifests.get(fragmentId);
  }

  /**
   * Returns every fragment whose `pierce` patterns cover this page path, in registration order.
   *
   * A page may compose several independently deployed fragments; each is pierced into the slot
   * that names it.
   */
  async matchPierceRoutes(pathname: string): Promise<ResolvedFragmentManifest[]> {
    await this.#load();

    // Deduplicated by fragment. Routes are compiled one per *pattern*, so a fragment declaring
    // both `/billing` and `/billing/*` matches `/billing` twice — the second through the
    // trailing-slash tolerance. Returning it twice would fetch that fragment twice per page load
    // and pierce two copies of it into one slot; callers want the set of fragments that match,
    // not the set of patterns that did.
    const matched = new Map<string, ResolvedFragmentManifest>();
    for (const route of this.#pierceRoutes!) {
      if (route.matches(pathname) && !matched.has(route.manifest.id)) {
        matched.set(route.manifest.id, route.manifest);
      }
    }
    return [...matched.values()];
  }

  /** Every registered fragment, ordered by id so pagination is deterministic. */
  async listFragments(): Promise<ResolvedFragmentManifest[]> {
    const manifests = await this.#load();
    return [...manifests.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async #load(): Promise<Map<string, ResolvedFragmentManifest>> {
    if (this.#manifests) return this.#manifests;

    const source = this.#source;
    let manifests: FragmentManifest[];
    if (typeof source === 'function') {
      manifests = await source();
    } else if (typeof source === 'string') {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`braid-gateway: loading the registry from "${source}" failed with HTTP ${response.status}`);
      }
      manifests = (await response.json()) as FragmentManifest[];
    } else {
      manifests = source;
    }

    this.#manifests = indexManifests(manifests);
    this.#pierceRoutes = compilePierceRoutes(this.#manifests);
    return this.#manifests;
  }
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

function indexManifests(manifests: FragmentManifest[]): Map<string, ResolvedFragmentManifest> {
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
