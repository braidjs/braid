import { outboxFlushLock, withLock } from './locks.js';
import type { Outbox, QueuedEntry } from './outbox.js';

/**
 * Draining a queue: one implementation, used by the framework-neutral client and by every binding.
 *
 * This lived in two places once — here and in Angular's `OutboxService` — and the copies had already
 * drifted apart on what to do with an entry nobody can replay. Ordering, locking, retry, and give-up
 * are exactly the rules that must not have two answers, so they have one.
 */

export interface FlushResult {
  sent: number;
  failed: number;
  /** Entries still queued when the drain stopped. */
  remaining: number;
  /** True when another context held the lock and this call did no work. */
  skipped: boolean;
}

/** Replays one queued write. Receives the entry's stored input, never a closure. */
export type MutationRunner = (input: unknown, entry: QueuedEntry) => Promise<unknown>;

export interface DrainOptions {
  outbox: Outbox;
  /** Which application's queue this is. The flush lock is per owner. */
  owner: string;
  /** How this caller finds the runner for a mutation kind. */
  runnerFor: (mutationId: string) => MutationRunner | undefined;
  /** Attempts before an entry is abandoned. */
  maxAttempts?: number;
  /** Reports an entry that could not be replayed. Never silent. */
  onError?: (message: string, detail?: unknown) => void;
  /** Called after each successful send, so a caller can invalidate what the write touched. */
  onSent?: (entry: QueuedEntry) => void;
  /** Called after each abandoned entry, for the same reason. */
  onAbandoned?: (entry: QueuedEntry) => void;
}

/**
 * Drains one owner's queue, oldest first, under a lock held across tabs and realms.
 *
 * Four rules, each with a failure behind it:
 *
 * - **Strictly sequential.** Queued writes routinely depend on each other — create a thing, then
 *   rename the thing — and replaying them in parallel races them into the wrong order.
 * - **A failure stops the drain** rather than skipping ahead, for the same reason.
 * - **A permanently failing entry is abandoned loudly.** The user navigated away believing it saved,
 *   so its disappearance has to be reported to someone who can act on it.
 * - **An entry with no runner is kept, not dropped.** It means the app did not re-register that
 *   mutation kind at start-up, or renamed it between deploys — and dropping it discards a write the
 *   user was told had succeeded. Keeping it means a later build (or a rollback) can still send it,
 *   and `outbox.remove` is there for an operator who decides otherwise.
 */
export async function drainOutbox(options: DrainOptions): Promise<FlushResult> {
  const maxAttempts = options.maxAttempts ?? 5;

  // Declined rather than queued: a flush waiting behind another tab's would run against a queue that
  // tab had already drained. Per owner, so an unrelated application's disjoint queue does not wait.
  const outcome = await withLock(outboxFlushLock(options.owner), async () => {
    let sent = 0;
    let failed = 0;

    // Snapshot: entries queued mid-drain wait for the next pass.
    const snapshot = await options.outbox.mine();

    for (const [index, entry] of snapshot.entries()) {
      /**
       * A partitioned queue belongs to whoever was signed in when the drain began. Sending is slow
       * and sign-out does not wait for it, so before each later entry, check it is still this
       * session's to send: once someone else signs in, the rest of the snapshot is the previous
       * person's work, and replaying it would send it under the new person's session.
       */
      if (index > 0 && !(await stillQueued(options.outbox, entry.id))) break;

      const runner = options.runnerFor(entry.mutationId);

      if (!runner) {
        options.onError?.(
          `[skew/data] no registered mutation for "${entry.mutationId}" — the entry stays queued. ` +
            'Register this mutation kind during start-up so a queue rehydrated from storage has ' +
            'somewhere to go.',
          entry,
        );
        failed += 1;
        break;
      }

      try {
        await runner(entry.input, entry);
        await options.outbox.remove(entry.id, entry.partition);
        options.onSent?.(entry);
        sent += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        const attempts = await options.outbox.recordFailure(entry.id, message, entry.partition);

        if (attempts >= maxAttempts) {
          options.onError?.(`[skew/data] giving up on "${entry.mutationId}" after ${attempts} attempts`, error);
          await options.outbox.remove(entry.id, entry.partition);
          options.onAbandoned?.(entry);
        }
        break;
      }
    }

    return { sent, failed, remaining: (await visible(options.outbox))?.length ?? 0 };
  });

  return outcome.acquired
    ? { ...outcome.value, skipped: false }
    : // Reported rather than folded into `sent: 0`, which also happens when a drain ran and
      // everything failed — conflating them makes a dead server look like a busy tab.
      { sent: 0, failed: 0, remaining: (await options.outbox.mine()).length, skipped: true };
}

/** The queue as the current session sees it, or null when it sees none (nobody is signed in). */
async function visible(outbox: Outbox): Promise<QueuedEntry[] | null> {
  try {
    return await outbox.mine();
  } catch {
    return null;
  }
}

async function stillQueued(outbox: Outbox, id: string): Promise<boolean> {
  return (await visible(outbox))?.some((entry) => entry.id === id) ?? false;
}
