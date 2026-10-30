import { getBraidConfig, isDevMode } from '../config.js';

/**
 * What a fragment is allowed to do, declared by the host and enforced where enforcement is possible.
 *
 * The organising principle is that **every grant names who enforces it**, because they are not all
 * enforced by the same thing and pretending otherwise is how a capability system becomes theatre:
 *
 * | Grant | Enforced by | Trusted tier | Untrusted tier |
 * | --- | --- | --- | --- |
 * | `context` | **Braid** — the bus is ours | yes | yes |
 * | `sandbox` | the browser | n/a — no frame to sandbox | yes |
 * | `permissions` | the browser (Permissions-Policy) | n/a | yes |
 * | `network` | the browser (CSP), or nobody | **advisory only** | CSP on the fragment's own origin |
 * | `sharedGlobals` | **Braid** — realm-window accessors | compat and custom-element fragments | n/a — ignored, nothing to share across origins |
 * | `storage` | **Braid** — realm-window storage views | compat fragments | n/a — the browser already partitions a cross-origin frame |
 *
 * `context` is the one that matters most on the trusted tier, and the one Braid can actually
 * enforce there — because Phase 1 turned the context bus into a message, so "what may this fragment
 * read" became a question asked in exactly one place instead of a check to remember at every read.
 *
 * `network` is listed as advisory on the trusted tier rather than omitted. A trusted fragment runs
 * in a same-origin realm with the host's `fetch`; Braid does not patch host globals and will not
 * start, so this grant documents intent and feeds the registry's analysis. Recording that honestly
 * is better than either enforcing it badly or leaving people to assume it works.
 */

export interface ContextGrants {
  /**
   * Context keys this fragment may read. Absent means **every key** — the pre-grant behaviour, kept
   * as the default so that adding capabilities to one fragment does not silently starve the rest.
   */
  read?: string[];
  /** Reserved: context keys this fragment may publish. No fragment can publish today. */
  write?: string[];
}

export interface FragmentCapabilities {
  context?: ContextGrants;
  /** Additive `sandbox` tokens for an untrusted frame. */
  sandbox?: string[];
  /** Permissions-Policy features delegated into an untrusted frame. */
  permissions?: string[];
  /** Origins the fragment is expected to talk to. Advisory on the trusted tier — see above. */
  network?: string[];
  /**
   * Whose Web Storage the fragment sees. `'shared'` (the default) is the host origin's, as for any
   * same-origin frame. `'partitioned'` gives it a store of its own, keyed by fragment id;
   * `{ partition }` names a store several fragments share. See `compat/storage-partition.ts`.
   * Compat fragments only; ignored elsewhere.
   */
  storage?: StorageGrant;
  /**
   * Host globals this fragment reads and writes as its own — see `BraidOptions.sharedGlobals`.
   * Replaces the host-wide default when present; `[]` opts the fragment out. Trusted tier only.
   */
  sharedGlobals?: string[];
}

/**
 * Decides whether a context key may cross to a fragment, and says so once when it may not.
 *
 * Returning `undefined` rather than throwing is deliberate: an ungranted key must look to the
 * fragment exactly like a key nobody has published, because those two cases are genuinely the same
 * from inside the fragment and a distinct error would leak the shape of the host's context to code
 * that was specifically not given it.
 *
 * The dev-mode warning is the other half. Silence would be correct for production and miserable for
 * whoever is wondering why `user` is undefined, so the *host's* console names the missing grant —
 * host-side, because the host is where the grant is written.
 */
export function createContextGate(
  capabilities: FragmentCapabilities | undefined,
  fragmentId: string,
): (key: string) => boolean {
  const read = capabilities?.context?.read;
  if (!read) return () => true;

  const granted = new Set(read);
  const warned = new Set<string>();

  return (key: string) => {
    if (granted.has(key)) return true;

    if (isDevMode() && !warned.has(key)) {
      warned.add(key);
      console.warn(
        `[braid:${fragmentId}] context "${key}" was not delivered: it is not in this fragment's ` +
          `context.read grant (${[...granted].join(', ') || 'none'}). Add it to the fragment's ` +
          `capabilities if it should be.`,
      );
    }
    return false;
  };
}

/**
 * Resolves capabilities from the three places a host can write them, most authoritative first:
 *
 * 1. **the realm stub** — stamped by the gateway from the registry manifest (trusted tier only);
 * 2. **`initBraid({ capabilities })`** — the registry stand-in for gateway-free composition, which
 *    is the only source the untrusted tier has;
 * 3. **slot attributes** — `sandbox=`, `allow=` on the element itself.
 *
 * All three are host-controlled, so this is a precedence rule rather than a trust ranking: every
 * source is equally unable to be influenced by the fragment. The order reflects how centrally
 * managed each one is, so that a grant written once in the registry is not quietly widened by markup
 * on one page.
 */
export function resolveCapabilities(
  sources: Array<FragmentCapabilities | undefined>,
): FragmentCapabilities | undefined {
  const present = sources.filter((source): source is FragmentCapabilities => Boolean(source));
  if (present.length === 0) return undefined;
  // Later sources are less authoritative, so earlier ones are spread last and win.
  return present.reduceRight((merged, source) => ({ ...merged, ...source }), {} as FragmentCapabilities);
}

/**
 * The host globals a trusted fragment shares: its own `sharedGlobals` grant when it has one, the
 * host-wide `initBraid({ sharedGlobals })` default otherwise.
 *
 * Replaces rather than merges, like `context.read`: a grant written for one fragment says exactly
 * what that fragment gets, and `[]` is how a fragment with its own analytics stack opts out.
 */
export function resolveSharedGlobals(capabilities: FragmentCapabilities | undefined): readonly string[] {
  const names: unknown = capabilities?.sharedGlobals ?? getBraidConfig().sharedGlobals;
  // The stub's grant is manifest JSON, cast rather than parsed: a `"sharedGlobals": "dataLayer"`
  // typo must share nothing, not one host-writing accessor per character.
  if (!Array.isArray(names)) return [];
  return names.filter((name): name is string => typeof name === 'string' && name !== '');
}

/** A fragment's Web Storage grant. */
export type StorageGrant = 'shared' | 'partitioned' | { partition: string };

/**
 * The storage partition a fragment writes into, or `null` for the shared, host-origin store.
 *
 * The grant is manifest JSON, cast rather than parsed, so anything that is not exactly one of the
 * two partitioned forms is the shared default — a typo must not quietly move a fragment's data.
 */
export function resolveStoragePartition(capabilities: FragmentCapabilities | undefined, fragmentId: string): string | null {
  const grant: unknown = capabilities?.storage;
  if (grant === 'partitioned') return fragmentId;
  if (grant && typeof grant === 'object') {
    const partition = (grant as { partition?: unknown }).partition;
    if (typeof partition === 'string' && partition !== '') return partition;
  }
  return null;
}

/** Reads a capabilities block off a realm stub's adapter options, or off `initBraid` config. */
export function readCapabilities(source: unknown): FragmentCapabilities | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const capabilities = (source as { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== 'object') return undefined;
  return capabilities as FragmentCapabilities;
}
