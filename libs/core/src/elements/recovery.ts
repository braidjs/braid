import type { BraidErrorStage } from '../errors.js';

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

export interface Recovery {
  /** A boot failed at `stage`. Schedules a reboot if the stage is fixable and attempts remain. */
  onError(stage: BraidErrorStage, notEntitled: boolean): void;
  /** The fragment stopped answering. Schedules a reboot if attempts remain. */
  onGone(): void;
  /** Cancels a scheduled reboot and restores the full budget: the slot left the DOM. */
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
    const delayMs = policy.delayMs * 4 ** (attempts - 1);
    options.announce({ attempt: attempts, delayMs, reason });
    timer = setTimeout(() => {
      timer = undefined;
      options.reboot();
    }, delayMs);
  }

  return {
    onError(stage, notEntitled) {
      if (!notEntitled && RECOVERABLE_STAGES.has(stage)) schedule(stage);
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
