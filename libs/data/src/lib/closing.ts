import { drainOutbox, type DrainOptions } from './flush.js';

/**
 * Flushing the outbox when a fragment closes.
 *
 * `libs/core` gave fragments `env.onClosing()` — a bounded window, before teardown, in which to get
 * work off the device. Nothing was using it. This is the wiring, and it belongs here rather than in
 * core: core must not depend on the data layer, and the drain rules (ordering, locking, retry,
 * give-up) already have exactly one home.
 *
 * What this is *not*: a durability mechanism. The outbox is already durable — entries survive in
 * IndexedDB and replay on the next boot. What a close-time flush buys is **latency to the server**
 * for a user who may not come back to this page soon, which is why an unflushed entry is reported
 * as `deferred` rather than `dropped`. Nothing was lost; it just has not left yet.
 */

/** The `env.onClosing` shape, structurally — typed here so `@braidlabs/data` need not depend on core. */
export interface ClosingEnv {
  onClosing(
    handler: () => Promise<{ flushed: number; dropped: number; deferred?: number }>,
  ): () => void;
  setDirty(reason: string | null): void;
}

export interface FlushOnClosingOptions extends Omit<DrainOptions, 'onError'> {
  /** Reports an entry that could not be replayed. Never silent. */
  onError?: DrainOptions['onError'];
}

/**
 * Registers a close-time drain of this owner's queue.
 *
 * ```ts
 * flushOnClosing(env, { outbox, owner: 'checkout', runnerFor });
 * ```
 *
 * Returns the unregister function, so a fragment that swaps its outbox can replace the handler.
 */
export function flushOnClosing(env: ClosingEnv, options: FlushOnClosingOptions): () => void {
  return env.onClosing(async () => {
    const result = await drainOutbox(options);

    /**
     * A skipped drain is not a failed one.
     *
     * `skipped` means another tab held the flush lock — so that tab is sending these entries right
     * now, and reporting them as dropped here would raise an alarm about work that is actively in
     * flight somewhere else.
     */
    return {
      flushed: result.sent,
      // Only entries abandoned after max attempts are truly gone; `failed` counts an attempt that
      // will be retried, so it is deferred rather than dropped.
      dropped: 0,
      deferred: result.remaining,
    };
  });
}

/**
 * Keeps a slot's `dirty` declaration in step with the queue depth.
 *
 * Separate from the flush because they answer different questions at different times: this one
 * answers "would leaving lose something?" continuously, while the flush answers "did it get out?"
 * once. A host's `beforeunload` guard needs the first and cannot await the second.
 *
 * `count` is read on demand rather than tracked, so this stays correct when another tab drains the
 * shared queue.
 */
export async function trackDirty(
  env: ClosingEnv,
  count: () => Promise<number>,
  describe: (pending: number) => string = (pending) =>
    `${pending} unsent ${pending === 1 ? 'change' : 'changes'}`,
): Promise<void> {
  const pending = await count();
  env.setDirty(pending > 0 ? describe(pending) : null);
}
