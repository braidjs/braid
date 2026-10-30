import type { BraidError, BraidErrorStage } from '../errors.js';

/**
 * Self-healing slots: a fragment that fails for a reason a retry can fix is rebooted, a few times,
 * with growing gaps. Opt-in, through `initBraid({ recover })`.
 *
 * What counts as fixable is the point. A network blip, a deploy that briefly 404'd a chunk, a realm
 * whose frame went away (`gone`) — those are worth another try. A misconfigured slot, an adapter
 * this client does not have, terms the host and fragment cannot agree on, a user without access —
 * those fail identically every time, and retrying them only repeats the error and the request.
 */
export const RECOVERABLE_STAGES: ReadonlySet<BraidErrorStage> = new Set([
  'fragment-fetch',
  'realm-boot',
  'handshake',
  'boundary',
  'adapter-mount',
]);

export interface RecoveryPolicy {
  /** Reboots at most this many times per mount. */
  attempts: number;
  /** The first reboot's delay; each later one waits four times longer than the last. */
  delayMs: number;
}

export const DEFAULT_RECOVERY: RecoveryPolicy = { attempts: 3, delayMs: 1_000 };

/** No reboot waits longer than this, however many attempts are allowed. */
export const MAX_RECOVERY_DELAY_MS = 5 * 60_000;

/** The most attempts a host may ask for: past this, a fragment is not recovering, it is down. */
export const MAX_RECOVERY_ATTEMPTS = 10;

/**
 * A response that says the request itself is wrong — a 4xx, or a redirect (to a login, usually) —
 * comes back the same on every retry. 408 and 429 are the exceptions: they ask to be retried.
 */
function isDeterministicResponse(status: number | undefined): boolean {
  return status !== undefined && status >= 300 && status < 500 && status !== 408 && status !== 429;
}

export interface Recovery {
  /** A boot failed. Schedules a reboot if the failure is fixable and attempts remain. */
  onError(error: Pick<BraidError, 'stage' | 'httpStatus'>, notEntitled: boolean): void;
  /** The fragment stopped answering. Schedules a reboot if attempts remain. */
  onGone(): void;
  /**
   * Cancels a scheduled reboot and restores the full budget: the slot left the DOM, or the host
   * reloaded it itself.
   */
  reset(): void;
}

export interface RecoveryEvent {
  attempt: number;
  delayMs: number;
  /** The stage that failed, or `gone`. */
  reason: BraidErrorStage | 'gone';
}

export function createRecovery(options: {
  policy: () => RecoveryPolicy | undefined;
  /** Announces a scheduled reboot, before it waits. */
  announce: (event: RecoveryEvent) => void;
  /** Reboots, if the slot still needs it when the delay is up. */
  reboot: () => void;
}): Recovery {
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule(reason: RecoveryEvent['reason']): void {
    const policy = options.policy();
    if (!policy || timer !== undefined || attempts >= policy.attempts) return;
    attempts++;
    const delayMs = Math.min(policy.delayMs * 4 ** (attempts - 1), MAX_RECOVERY_DELAY_MS);
    options.announce({ attempt: attempts, delayMs, reason });
    timer = setTimeout(() => {
      timer = undefined;
      options.reboot();
    }, delayMs);
  }

  return {
    onError({ stage, httpStatus }, notEntitled) {
      if (!notEntitled && RECOVERABLE_STAGES.has(stage) && !isDeterministicResponse(httpStatus)) schedule(stage);
    },
    onGone() {
      schedule('gone');
    },
    reset() {
      clearTimeout(timer);
      timer = undefined;
      attempts = 0;
    },
  };
}
