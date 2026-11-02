/**
 * Message types that are not the handshake and not context.
 *
 * Both of these crossed the boundary before Weave existed, and both crossed it *unevenly*: the
 * context bus cloned, while props and events handed live host-realm objects to fragment code. That
 * asymmetry was invisible on the trusted tier and is unshippable on the untrusted one, so both are
 * corrected here rather than carried forward.
 */

/** Host → fragment. A complete props snapshot, cloned. Never a patch — see below. */
export const PROPS_CHANGED = 'props/changed';

/** Fragment → host. Surfaced on the slot element as `braid:event`. */
export const FRAGMENT_EVENT = 'frag/event';

export interface PropsChangedPayload {
  /**
   * The whole props object, every time.
   *
   * A diff would be smaller and would also require both ends to agree on how to apply one — which
   * is a second protocol, with its own skew problem, protecting a payload that is a handful of
   * fields on every real page. Sending the whole thing keeps "what does this fragment think its
   * props are" answerable by looking at one message.
   */
  props: Record<string, unknown>;
}

export interface FragmentEventPayload {
  type: string;
  detail?: unknown;
}

/**
 * Fragment → host. The fragment's first content has settled: its own loading is done, not just its
 * mount. Surfaced on the slot as the `settled` attribute and a `braid:settled` event.
 *
 * Separate from liveness on purpose. `healthy` proves the realm's event loop is turning, which is
 * true from the first beat — while the application inside may still be showing its own spinner. Only
 * the fragment knows when it has something worth looking at, so this is the fragment's to say, once.
 */
export const SETTLED = 'frag/settled';

/**
 * Where a compat fragment finds its reporter: on its realm's global, under a registered symbol.
 *
 * A compat fragment is an unmodified app that never receives an env, so the one thing it may want
 * to say has to be reachable from a global. A registered symbol rather than a name: it collides with
 * nothing the app defines, and every copy of `@braidlabs/core` — the host's, and any bundled into
 * the fragment — resolves the same one.
 */
export const BRAID_FRAGMENT_REPORTER = Symbol.for('braid.fragment');

export interface BraidFragmentReporter {
  /** Reports the fragment's first content as settled. Later calls do nothing. */
  settled(): void;
}

/** The reporter the realm this code runs in was given, or undefined outside a Braid realm. */
export function braidFragmentReporter(): BraidFragmentReporter | undefined {
  return (globalThis as Record<symbol, BraidFragmentReporter | undefined>)[BRAID_FRAGMENT_REPORTER];
}
