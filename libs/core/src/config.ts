/**
 * Library-wide configuration for the Braid client runtime, set via `initBraid(options)`.
 *
 * Note there is no host-isolation mode switch: host purity is an invariant, not a mode.
 * Braid never installs anything on a host-page global or prototype — in any mode, ever. The compat
 * adapter achieves its interception with fragment-boundary techniques confined to each fragment's
 * own realm and shadow DOM subtree. The one channel back is `sharedGlobals`: host globals the host
 * names itself, which trusted fragments may then read and write.
 */

import type { HostContract } from './weave/contract.js';
import { DEFAULT_RECOVERY, RecoveryPolicy } from './elements/recovery.js';
import type { FragmentCapabilities } from './weave/capabilities.js';
import type { PrerequisiteResolver } from './elements/prerequisites.js';

export interface BraidOptions {
  /**
   * What this host offers fragments, as a contract they can require a range of.
   *
   * Optional, and its absence means "no contract declared" rather than "version 0" — a host that
   * declares nothing composes every fragment that requires nothing, which is every fragment that
   * exists today.
   */
  contract?: HostContract;

  /**
   * Per-fragment capability grants, by fragment id.
   *
   * The registry is the usual source — the gateway stamps a trusted fragment's capabilities onto
   * its realm stub — but the untrusted tier has no gateway, so a host composing cross-origin
   * fragments declares them here instead. Both sources are host-controlled, which is the invariant
   * that matters; where both speak, the registry wins.
   */
  capabilities?: Record<string, FragmentCapabilities>;

  /**
   * Host globals that trusted fragments share instead of getting a realm-local copy:
   *
   * ```ts
   * initBraid({ sharedGlobals: ['dataLayer', 'adobeDataLayer', '_satellite', 'KAMPYLE'] });
   * ```
   *
   * A compat fragment's JavaScript runs in its own realm, so without this its
   * `window.dataLayer.push(…)` lands in an array no tag manager is watching, and the usual "fix" is
   * a second copy of the vendor script. Each name here becomes a realm-window accessor that reads
   * and writes the host's property, live.
   *
   * **This lets fragments write host globals** — the names you list, and nothing else. Prefer that
   * the host initializes each one (an object a fragment creates outlives the fragment), and note
   * that a fragment's own `<script src>` for the vendor still runs unless it checks first
   * (`if (!window._satellite)`).
   *
   * Trusted fragments only (compat and custom-element); the untrusted tier ignores it, as do
   * contract fragments, whose host API is the contract. A fragment's
   * `capabilities.sharedGlobals` replaces this default, and `[]` opts it out. Names the fragment's
   * realm already defines (`location`, `document`, constructors…) are skipped.
   */
  sharedGlobals?: string[];

  /**
   * Values to define on each trusted fragment's realm window before any of its code runs — a
   * per-fragment global, where `sharedGlobals` can only forward a host one:
   *
   * ```ts
   * initBraid({ realmGlobals: braidDesktopAgent.realmGlobals }); // window.fdc3, bound to each fragment
   * ```
   *
   * Called once per boot with the fragment's id and a signal that aborts when it is torn down, so
   * whatever was handed out can be released. Return `undefined` to give a fragment nothing. A hook
   * that throws or rejects gives that fragment nothing and does not fail its boot. Names the realm
   * already defines are skipped, as with `sharedGlobals`.
   *
   * Trusted fragments only (compat and custom-element); contract and untrusted fragments ignore it.
   */
  realmGlobals?: RealmGlobalsHook;

  /**
   * Enables development-mode diagnostics: unaudited-API warnings from the compat document
   * facade, boundary-bypass reports, and verbose boot logging. Defaults to false.
   */
  dev?: boolean;

  /**
   * Host navigation adapter. Bound fragments need to know when the host application navigates
   * (e.g. the host router calls `history.pushState`). Braid never patches the host History API,
   * so wire your router's after-navigation hook to the provided `notify` callback:
   *
   * ```ts
   * initBraid({ onHostNavigation: (notify) => router.afterEach(() => notify()) });
   * ```
   *
   * Where the Navigation API is available, host navigations are additionally observed
   * automatically. Back/forward navigations (`popstate`) are always observed natively and need
   * no adapter.
   */
  onHostNavigation?: (notify: () => void) => void;

  /**
   * The path the Braid gateway is mounted under (`/manage`), when the host shares its domain and
   * does not own the root. Must match the gateway's `basePath`: the client fetches realm stubs and
   * fragment documents from `/manage/__braid/…`. Call `initBraid` before any slot connects.
   */
  basePath?: string;
  /**
   * Resolvers for mount prerequisites: named things that must be ready before a fragment's code
   * runs, such as a warm session for its authorization server. Keyed by exact key or by a
   * `prefix*` pattern. A fragment declares the keys it needs with `<fragment-slot requires="…">`
   * or its manifest's `requires`. See `elements/prerequisites.ts`.
   *
   * ```ts
   * initBraid({ prerequisites: { 'session:*': (key, { signal }) => sessions.ensure(key, { signal }) } });
   * ```
   */
  prerequisites?: Record<string, PrerequisiteResolver>;
  /** How long a prerequisite may take before its fragment fails. Defaults to 15 seconds. */
  prerequisiteTimeoutMs?: number;
  /**
   * Reboot a fragment that fails for a reason a retry can fix — its fetch, its realm, its
   * handshake or mount failed, or it stopped answering (`gone`) — up to three times per mount, after
   * 1, 4 and 16 seconds. Off by default. `true` takes those defaults; an object sets them. See
   * `elements/recovery.ts` for what is and is not retried.
   */
  recover?: boolean | { attempts?: number; delayMs?: number };
}

/** See {@link BraidOptions.realmGlobals}. */
export type RealmGlobalsHook = (fragment: {
  fragmentId: string;
  signal: AbortSignal;
}) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;

interface ResolvedBraidConfig {
  dev: boolean;
  /** Empty, or an absolute path with no trailing slash. */
  basePath: string;
  contract?: HostContract;
  capabilities?: Record<string, FragmentCapabilities>;
  sharedGlobals?: string[];
  realmGlobals?: RealmGlobalsHook;
  onHostNavigation?: (notify: () => void) => void;
  prerequisites?: Record<string, PrerequisiteResolver>;
  prerequisiteTimeoutMs?: number;
  recover?: RecoveryPolicy;
}

const config: ResolvedBraidConfig = {
  dev: false,
  basePath: '',
};

export function setBraidConfig(options: BraidOptions = {}): void {
  if (options.dev !== undefined) {
    config.dev = options.dev;
  }
  if (options.contract) {
    config.contract = options.contract;
  }
  if (options.capabilities) {
    config.capabilities = options.capabilities;
  }
  if (options.sharedGlobals) {
    config.sharedGlobals = options.sharedGlobals;
  }
  if (options.realmGlobals) {
    config.realmGlobals = options.realmGlobals;
  }
  if (options.onHostNavigation) {
    config.onHostNavigation = options.onHostNavigation;
  }
  if (options.prerequisites) {
    config.prerequisites = options.prerequisites;
  }
  if (options.prerequisiteTimeoutMs !== undefined) {
    if (!Number.isFinite(options.prerequisiteTimeoutMs) || options.prerequisiteTimeoutMs <= 0) {
      throw new Error(`braid: prerequisiteTimeoutMs must be a positive number of milliseconds`);
    }
    config.prerequisiteTimeoutMs = options.prerequisiteTimeoutMs;
  }
  if (options.recover !== undefined) {
    if (options.recover === false) {
      delete config.recover;
    } else {
      const { attempts, delayMs } = { ...DEFAULT_RECOVERY, ...(options.recover === true ? {} : options.recover) };
      if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(delayMs) || delayMs < 0) {
        throw new Error(`braid: recover needs a positive whole number of attempts and a delayMs of zero or more`);
      }
      config.recover = { attempts, delayMs };
    }
  }
  // Kept in sync with the gateway's normalizeBasePath: a path the URL parser would rewrite (`/café`,
  // a dot segment) could never match the parsed pathnames the gateway compares it to.
  if (options.basePath !== undefined) {
    const basePath = options.basePath.replace(/\/+$/, '');
    if (basePath && (!/^(\/[^/?#\s]+)+$/.test(basePath) || new URL(basePath, 'http://braid.invalid').pathname !== basePath)) {
      throw new Error(`braid: basePath "${options.basePath}" must be an absolute path such as "/manage"`);
    }
    config.basePath = basePath;
  }
}

export function getBraidConfig(): Readonly<ResolvedBraidConfig> {
  return config;
}

export function isDevMode(): boolean {
  return config.dev;
}
