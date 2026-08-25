import { EnvContext } from '../env/fragment-env.js';
import type { ContextBusLike } from '../context/context-bus.js';
import { BoundaryChannel } from './channel.js';
import { OpenPayload } from './handshake.js';
import { FragmentCapabilities, createContextGate } from './capabilities.js';

/**
 * Context across the boundary — a **mirror**, not a remote call.
 *
 * The obvious implementation is a request per read: `env.context.get('cart')` sends `ctx/get` and
 * awaits a reply. It is also wrong, and wrong in a way that would be very expensive to walk back.
 * `EnvContext.get` is synchronous today, and a transport that cannot preserve that forces the
 * signature to become `Promise<unknown>` — which is a public API break, and worse, a break that
 * would land differently on each tier: synchronous on trusted, asynchronous on untrusted.
 *
 * So the fragment holds a local mirror instead. The host seeds it in full at OPEN and pushes every
 * subsequent change. Reads never leave the realm, so `get` stays synchronous forever and works
 * unchanged over a `MessagePort` in Phase 5.
 *
 * Three consequences worth naming, because each is an improvement rather than a compromise:
 *
 * 1. **Projection happens once per change, not once per read.** The host projects a value to the
 *    fragment's declared version when it pushes; today's bus re-projects on every single `get`.
 * 2. **Reachability is decided at the handshake**, before any state has crossed, rather than at
 *    first subscribe. The bus already argues for the earlier of two moments; this is earlier still.
 * 3. **Phase 6's grants have somewhere to live.** What a fragment may read becomes a question about
 *    what enters its mirror, asked in one place, rather than a check to remember at every read.
 */

export const CTX_CHANGED = 'ctx/changed';

export interface ContextChangedPayload {
  key: string;
  /** Absent when the key was removed or became unprojectable for this fragment. */
  value?: unknown;
}

export interface AttachContextRouterOptions {
  /**
   * The bus this fragment's context is routed to.
   *
   * Injected, never imported — see `ContextBusLike`. Most fragments resolve to the page bus; one
   * given a `scope` resolves to a bus of its own, and this argument is the only thing that differs.
   */
  bus: ContextBusLike;
  /**
   * Which bus this router speaks for. `undefined` is the page bus.
   *
   * Stamped onto every `ctx/changed` it sends and matched against what the mirror expects, so a
   * fragment attached to two buses can tell their traffic apart. Reserved on the envelope since
   * Phase 1 for exactly this.
   */
  scope?: string;
  channel: BoundaryChannel;
  fragmentId: string;
  /** The versions agreed at handshake, already merged with the manifest's. */
  contextVersions: Readonly<Record<string, number>>;
  /**
   * What this fragment may read. Absent grants everything, which is the pre-capability behaviour.
   *
   * Applied here rather than at the read site because the mirror is the choke point: a key that
   * never enters it cannot be read, cannot be subscribed to, and cannot be inferred from a
   * subscription that never fires.
   */
  capabilities?: FragmentCapabilities;
  signal: AbortSignal;
}

/**
 * Host side: projects the bus into one fragment's mirror and keeps it current.
 *
 * Returns the opening snapshot, which the caller puts on the OPEN payload — the router does not
 * send it itself, because OPEN carries props too and two messages where one would do is two chances
 * for a fragment to observe half a world.
 */
export function attachContextRouter(options: AttachContextRouterOptions): Record<string, unknown> {
  const { bus, channel, fragmentId, contextVersions, signal } = options;
  const mayRead = createContextGate(options.capabilities, fragmentId);

  const readFor = (key: string): { ok: true; value: unknown } | { ok: false } => {
    const as = contextVersions[key];
    try {
      return { ok: true, value: bus.get(key, { ...(as === undefined ? {} : { as }), fragmentId }) };
    } catch (error) {
      /**
       * One unprojectable key must not cost the fragment every other key.
       *
       * The handshake already refused the versions it could see, so reaching here means a schema
       * was registered — or a key first published — after this fragment mounted, which is a
       * deployment race rather than a misconfiguration the developer can fix in advance. Report it
       * and leave that one key absent.
       */
      console.error(`[braid:${fragmentId}] context "${key}" could not be projected for this fragment`, error);
      return { ok: false };
    }
  };

  const snapshot: Record<string, unknown> = {};
  for (const key of bus.keys()) {
    if (!mayRead(key)) continue;
    const read = readFor(key);
    if (read.ok) snapshot[key] = read.value;
  }

  const unobserve = bus.observe((key) => {
    if (signal.aborted) return;

    /**
     * A denied key sends **nothing at all** — not a change, not a deletion.
     *
     * The obvious implementation sends a valueless `ctx/changed` and lets the mirror treat it as an
     * absence, which produces the right value and the wrong behaviour: the fragment learns that a
     * key it was refused exists, and learns the exact moment it changes. That is a timing channel
     * on precisely the data the grant was written to withhold, and it is invisible in any test that
     * only checks what `get()` returns.
     */
    if (!mayRead(key)) return;

    const read = readFor(key);
    /**
     * An unprojectable key *does* send the valueless form, and the difference matters: that key was
     * granted, so clearing a now-stale mirror entry is the honest thing to do, and the fragment was
     * always allowed to know it exists.
     */
    const payload: ContextChangedPayload = read.ok ? { key, value: read.value } : { key };
    channel.send(CTX_CHANGED, payload, ...(options.scope === undefined ? [] : [{ scope: options.scope }]));
  });

  signal.addEventListener('abort', unobserve, { once: true });
  return snapshot;
}

/**
 * Fragment side: the mirror, presented as the `EnvContext` a fragment already expects.
 *
 * Note what is *not* here — no version negotiation, no projection, no Skew. All of that stayed in
 * the host bus, which is the point: the fragment receives values already in the shape it declared,
 * so the migration engine never has to run in a realm whose code may be older than the schemas.
 */
export function createContextMirror(
  channel: BoundaryChannel,
  scope?: string,
): EnvContext & { seed(open: OpenPayload): void } {
  const values = new Map<string, unknown>();
  const listeners = new Map<string, Set<(value: unknown) => void>>();

  /**
   * Registered *on this mirror's scope*, so two mirrors on one channel do not displace each other.
   *
   * Without scope in the address, a fragment reading both its own bus and the page bus would have
   * the second registration silently replace the first, and one of the two buses would simply go
   * quiet — a failure with no error and no symptom except missing updates.
   */
  channel.on(CTX_CHANGED, (payload) => {
    const { key, value } = (payload ?? {}) as ContextChangedPayload;
    if (typeof key !== 'string') return;

    if (value === undefined) values.delete(key);
    else values.set(key, value);

    for (const listener of [...(listeners.get(key) ?? [])]) {
      try {
        listener(value);
      } catch (error) {
        // Same isolation rule the bus applies, for the same reason: one component's broken
        // effect must not present as a different component silently failing to update.
        console.error(`braid: a "${key}" context subscriber threw; other subscribers were unaffected`, error);
      }
    }
  }, ...(scope === undefined ? [] : [{ scope }]));

  return {
    seed(open: OpenPayload) {
      for (const [key, value] of Object.entries(open.context ?? {})) values.set(key, value);
    },

    get(key: string): unknown {
      return values.get(key);
    },

    subscribe(key, listener, subscribeOptions) {
      let keyListeners = listeners.get(key);
      if (!keyListeners) {
        keyListeners = new Set();
        listeners.set(key, keyListeners);
      }
      keyListeners.add(listener);

      const unsubscribe = () => void keyListeners.delete(listener);
      subscribeOptions?.signal?.addEventListener('abort', unsubscribe, { once: true });
      channel.closed.addEventListener('abort', unsubscribe, { once: true });
      return unsubscribe;
    },
  };
}
