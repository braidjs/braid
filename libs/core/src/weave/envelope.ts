/**
 * The Weave envelope — the unit that crosses a fragment boundary.
 *
 * Braid already had a *bus*: `braidContext` publishes with structured cloning, per-subscriber
 * Skew projection and subscriber isolation. What it did not have was a **wire**. A fragment
 * reached the bus because the host built `env.context` as closures over `braidContext` and handed
 * that object into the realm — a synchronous cross-realm call on a shared object graph. That works
 * for a same-origin realm and for nothing else: a closure cannot be handed to another origin, which
 * is the real reason the untrusted tier throws rather than degrades.
 *
 * This module is the addressing layer that was missing underneath. The bus's semantics are
 * unchanged and are not re-implemented here — they remain the specification this format serves.
 */

/**
 * Version of the Weave envelope format.
 *
 * Deliberately distinct from `BRAID_PROTOCOL_VERSION`, which versions the *client ↔ gateway*
 * composition protocol. The two move for unrelated reasons: a change to how the gateway namespaces
 * fragment assets has nothing to do with how a mounted fragment talks to its host, and a single
 * number covering both would force one side to break for the other's benefit.
 */
export const WEAVE_VERSION = 1;

/** A failure delivered as a reply, rather than thrown into a realm that cannot catch it. */
export interface WeaveErrorPayload {
  message: string;
  /** Mirrors `BraidErrorStage` where the failure had one; absent for transport-level faults. */
  stage?: string;
  fixHint?: string;
}

export interface Envelope {
  v: typeof WEAVE_VERSION;
  /** Unique per message. Correlates a reply to its request; also useful in a trace. */
  id: string;
  /**
   * Set only on a reply, to the `id` being answered.
   *
   * A reply is not a message type — it is any message answering another. Keeping that in a field
   * rather than in `type` means a handler for `ctx/get` never has to know whether the value it
   * returns will be delivered as a reply or dropped; the channel decides from `reply` below.
   */
  re?: string;
  /** Set on a request to mean "a reply to this id is expected". */
  reply?: true;
  type: string;
  fragmentId: string;
  /**
   * Document-instance id: unique to one boot of one fragment, surviving nothing — not a reload,
   * not a re-mount of the same fragment into the same slot.
   *
   * Cheap to carry now and expensive to add later, because it is the only thing that distinguishes
   * "the fragment reloaded" from "this is a different fragment". Liveness (Phase 2) needs it to
   * avoid crediting a dead instance's beats to its replacement, and negotiated teardown (Phase 3)
   * needs it to avoid ACKing a close on behalf of an instance that never received it.
   */
  instance: string;
  /**
   * Which bus this addresses. `undefined` means the host bus — which is every message today.
   *
   * Reserved, unused, and deliberately not removed: the fragment-local bus is planned last, and
   * without this field a context message addresses a *key* but not a *bus*. Introducing a second
   * bus later would then mean either bumping `WEAVE_VERSION` or smuggling the scope into the key
   * string, and both are worse than one optional field nothing currently sets.
   */
  scope?: string;
  payload?: unknown;
  /** Set on a reply that failed. Mutually exclusive with a meaningful `payload`. */
  error?: WeaveErrorPayload;
}

/**
 * Identity generator for message and instance ids.
 *
 * `crypto.randomUUID` is required to be present in a secure context and is available in every
 * environment Braid targets, but it is absent over plain http on a LAN address — a configuration
 * developers hit constantly when testing on a phone — so the fallback exists to keep the dev loop
 * working rather than to be cryptographically interesting. Ids here are correlation handles, never
 * capabilities: nothing is authorized by holding one.
 */
export function weaveId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Narrows an unknown message — anything can arrive on a port — to a well-formed envelope. */
export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Envelope>;
  return (
    candidate.v === WEAVE_VERSION &&
    typeof candidate.id === 'string' &&
    typeof candidate.type === 'string' &&
    typeof candidate.fragmentId === 'string' &&
    typeof candidate.instance === 'string'
  );
}
