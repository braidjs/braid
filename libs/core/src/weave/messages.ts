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
