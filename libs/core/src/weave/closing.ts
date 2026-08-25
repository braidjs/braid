import { BraidError } from '../errors.js';
import { BoundaryChannel } from './channel.js';

/**
 * Teardown as a negotiation.
 *
 * Before this, `#teardown()` aborted the instance signal and dropped the subtree in one synchronous
 * step. That is fine for a fragment whose state is all on screen and wrong for every fragment that
 * has any. With `libs/data`'s optimistic writes and persistent outbox in the picture, unmounting a
 * fragment mid-flush discards work the user has already been told was saved — and it does so
 * silently, which is the part that makes it a bug rather than a limitation.
 *
 * ```
 * host → CLOSE { reason, deadlineMs }
 *          fragment enters `closing` — flush the outbox, persist drafts, release locks
 * frag → ACK   { flushed, dropped }
 *          host completes teardown
 * ```
 *
 * The deadline is not negotiable and not extendable. **A teardown that can block forever is a worse
 * bug than a teardown that loses a draft**: the first freezes a page the user is trying to leave,
 * and the second at least leaves them somewhere. So the host proceeds when the deadline expires and
 * reports what it could not confirm.
 */

export const CLOSE = 'weave/close';
export const DIRTY = 'frag/dirty';

export type CloseReason =
  /** The slot left the DOM. */
  | 'unmount'
  /** The same fragment is about to boot again into the same slot. */
  | 'reload'
  /** The host is navigating away from the route this fragment was mounted for. */
  | 'navigate';

export interface ClosePayload {
  reason: CloseReason;
  deadlineMs: number;
}

export interface CloseSummary {
  /** Work sent successfully during the close. */
  flushed: number;
  /** Work that will not arrive — abandoned, or belonging to a handler that failed. */
  dropped: number;
  /**
   * Work not sent, but safely persisted, so it will be retried on a later boot.
   *
   * A third category rather than a rounding of the other two, because it is genuinely neither: an
   * outbox entry still in IndexedDB has not been flushed and has not been lost. Folding it into
   * `dropped` would raise an alarm about data that is fine; folding it into `flushed` would claim a
   * write reached the server when it has not left the device.
   */
  deferred?: number;
}

export interface CloseResult extends CloseSummary {
  /** False when the deadline expired first — in which case the counts are what the host could see. */
  acknowledged: boolean;
}

export interface DirtyPayload {
  /** Human-readable reason the fragment has unsaved work, or null when it no longer does. */
  reason: string | null;
}

/** Two seconds: long enough for a queued flush over a slow connection, short enough to leave on. */
const CLOSE_DEADLINE_MS = 2_000;

export interface CloseFragmentOptions {
  channel: BoundaryChannel;
  fragmentId: string;
  reason: CloseReason;
  deadlineMs?: number;
  /** Reports a deadline overrun. Defaults to `console.error`. */
  onOverrun?(error: BraidError): void;
}

/** Host side: asks the fragment to close, and waits — but only for so long. */
export async function closeFragment(options: CloseFragmentOptions): Promise<CloseResult> {
  const { channel, fragmentId, reason } = options;
  const deadlineMs = options.deadlineMs ?? CLOSE_DEADLINE_MS;

  const payload: ClosePayload = { reason, deadlineMs };

  try {
    const summary = await channel.request<CloseSummary>(CLOSE, payload, { timeoutMs: deadlineMs });
    return {
      acknowledged: true,
      flushed: Number(summary?.flushed ?? 0),
      dropped: Number(summary?.dropped ?? 0),
      deferred: Number(summary?.deferred ?? 0),
    };
  } catch (cause) {
    /**
     * No ACK. The counts are unknown rather than zero, and saying so is the point of this branch —
     * a fragment that wedged mid-flush may have persisted everything, nothing, or half of it, and
     * a report of `dropped: 0` here would be a lie told in a reassuring tone.
     */
    const error = new BraidError(`the fragment did not acknowledge close within ${deadlineMs}ms`, {
      fragmentId,
      stage: 'teardown',
      cause,
      fixHint:
        'the fragment may have unflushed work — check its env.onClosing() handlers, or raise the deadline ' +
        'if a slow flush is expected here',
    });
    (options.onOverrun ?? ((reported: BraidError) => console.error(reported)))(error);
    return { acknowledged: false, flushed: 0, dropped: 0 };
  }
}

export interface CloseAndDisposeOptions extends CloseFragmentOptions {
  /** Aborts the instance signal and closes the channel. Called once, after the negotiation ends. */
  dispose(): void;
}

/**
 * The ordering the whole phase exists to establish: **negotiate, then dispose.**
 *
 * Named and extracted rather than inlined into `<fragment-slot>` because it is a one-line sequence
 * that is worthless in the wrong order — a `dispose()` before the await aborts `env.signal` while
 * the fragment is still flushing, which is precisely the silent data loss this phase set out to
 * fix, and it would still pass every test that only checked the counts.
 */
export async function closeAndDispose(options: CloseAndDisposeOptions): Promise<CloseResult> {
  const { dispose, ...closeOptions } = options;
  const result = await closeFragment(closeOptions);
  dispose();
  return result;
}

export type ClosingHandler = (reason: CloseReason) => void | Partial<CloseSummary> | Promise<void | Partial<CloseSummary>>;

export interface ClosingCoordinator {
  /** Registers work to run before the instance signal aborts. Returns an unregister function. */
  onClosing(handler: ClosingHandler): () => void;
  /** Declares (or clears) unsaved work. Pushed to the host as it changes, not asked for at close. */
  setDirty(reason: string | null): void;
  readonly dirty: string | null;
}

/**
 * Fragment side: answers CLOSE by running every registered handler, and tracks dirty state.
 *
 * Dirty state is a **continuous** channel rather than a question asked during teardown, and that is
 * deliberate. Asking "do you have unsaved work?" at close time is too late whenever the answer
 * needs a round trip of its own — and a host that wants to warn the user before a page unload needs
 * the answer synchronously, at a moment when it cannot await anything at all.
 */
export function createClosingCoordinator(channel: BoundaryChannel): ClosingCoordinator {
  const handlers = new Set<ClosingHandler>();
  let dirty: string | null = null;

  channel.on(CLOSE, async (payload): Promise<CloseSummary> => {
    const { reason } = (payload ?? { reason: 'unmount' }) as ClosePayload;

    /**
     * `async` on the wrapper is load-bearing, not stylistic.
     *
     * A handler that throws *synchronously* escapes a bare `.map(handler)` before `allSettled` ever
     * sees it, rejecting the whole CLOSE reply — so one broken handler would take every other
     * handler's flush down with it and report nothing. The wrapper turns a synchronous throw into a
     * rejected promise, which is the isolation the bus applies to subscribers for the same reason.
     */
    const results = await Promise.allSettled([...handlers].map(async (handler) => handler(reason)));

    let flushed = 0;
    let dropped = 0;
    let deferred = 0;
    for (const result of results) {
      if (result.status === 'rejected') {
        // A handler that throws has failed to flush whatever it was responsible for. Counting it as
        // a drop is the conservative reading, and the only one that does not overstate success.
        dropped += 1;
        console.error('braid: a closing handler threw; its work is reported as dropped', result.reason);
        continue;
      }
      const summary = result.value;
      if (summary && typeof summary === 'object') {
        flushed += Number(summary.flushed ?? 0);
        dropped += Number(summary.dropped ?? 0);
        deferred += Number(summary.deferred ?? 0);
      }
    }

    return { flushed, dropped, deferred };
  });

  return {
    onClosing(handler) {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },

    setDirty(reason) {
      if (dirty === reason) return;
      dirty = reason;
      channel.send(DIRTY, { reason } satisfies DirtyPayload);
    },

    get dirty() {
      return dirty;
    },
  };
}
