/**
 * Library-wide configuration for the Braid client runtime, set via `initBraid(options)`.
 *
 * Note there is no host-isolation mode switch: host purity is an invariant, not a mode.
 * Braid never mutates a host-page global or prototype — in any mode, ever. The compat adapter
 * achieves its interception with fragment-boundary techniques confined to each fragment's own
 * realm and shadow DOM subtree.
 */

import type { HostContract } from './weave/contract.js';
import type { FragmentCapabilities } from './weave/capabilities.js';

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
}

interface ResolvedBraidConfig {
  dev: boolean;
  /** Empty, or an absolute path with no trailing slash. */
  basePath: string;
  contract?: HostContract;
  capabilities?: Record<string, FragmentCapabilities>;
  onHostNavigation?: (notify: () => void) => void;
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
  if (options.onHostNavigation) {
    config.onHostNavigation = options.onHostNavigation;
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
