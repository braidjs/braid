import { BoundaryChannel } from './channel.js';

/**
 * Liveness — the fragment as a session rather than a mount.
 *
 * Before this, `<fragment-slot>` had four states and `ready` was terminal: a fragment whose realm
 * wedged in a `while (true)` reported `ready` forever, and the only symptom was a region of the page
 * that had quietly stopped being an application. The host had no way to tell "finished rendering"
 * from "stopped existing".
 *
 * ```
 * idle → connecting → healthy ⇄ unobservable
 *                        ↓           ↓
 *                     suspect  →   gone
 * ```
 *
 * The state that makes this correct rather than merely present is **`unobservable`**. Browsers
 * throttle timers in hidden tabs — to once a second, then far less after a few minutes — so a naive
 * heartbeat reports mass death the moment a user switches tabs, and a team that has seen that once
 * will turn the whole feature off. `unobservable` is not a fault: it is the host saying it has
 * stopped being able to tell, which is a different claim from the fragment being unwell.
 */

export const BEAT = 'weave/beat';

export type LivenessState = 'connecting' | 'healthy' | 'unobservable' | 'suspect' | 'gone';

/**
 * Where "can the fragment be observed right now?" is answered from.
 *
 * An interface rather than a direct `document.visibilityState` read so the two ends can be driven
 * from the same source in a test. Both ends must agree — the fragment stops beating and the host
 * suspends its deadline — and they agree by consulting the same document, which holds on the
 * trusted tier (one document) and on the untrusted one (an iframe's visibility follows its top
 * level).
 */
export interface VisibilitySource {
  isHidden(): boolean;
  onChange(listener: () => void): () => void;
}

export function documentVisibility(): VisibilitySource {
  return {
    isHidden: () => document.visibilityState === 'hidden',
    onChange(listener) {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

/**
 * The timer source a fragment's beats are scheduled on.
 *
 * This is the whole point of the fragment half, and the easiest thing to get wrong: scheduling
 * beats on the *host's* `setInterval` would produce a perfectly steady heartbeat from a realm that
 * had stopped executing. The beat has to be scheduled on the realm's own event loop — pass
 * `realm.window` — so that a fragment spinning in a synchronous loop stops beating, because its
 * timers stop firing. A beat proves the realm's task queue is turning; nothing else here does.
 */
export interface BeatScheduler {
  setInterval(handler: () => void, ms: number): number;
  clearInterval(id: number): void;
  /** Used for the opening beat, which must be evidence on the same terms as every other beat. */
  setTimeout(handler: () => void, ms: number): number;
}

/** Two seconds: three missed beats is six, comfortably under a person's patience for a dead panel. */
const BEAT_INTERVAL_MS = 2_000;
/** Three, so one dropped beat under load is not a diagnosis. */
const GRACE_BEATS = 3;
/** Fifteen seconds of silence from a fragment that should be running is not a slow fragment. */
const GONE_AFTER_MS = 15_000;

export interface HostLivenessOptions {
  channel: BoundaryChannel;
  /** The instance whose beats count. Beats stamped with any other instance are ignored. */
  instance: string;
  signal: AbortSignal;
  onState(state: LivenessState, previous: LivenessState): void;
  beatIntervalMs?: number;
  graceBeats?: number;
  goneAfterMs?: number;
  visibility?: VisibilitySource;
  /**
   * Listen now, judge later: the beat handler is registered immediately, and the first deadline is
   * armed only once this settles.
   *
   * The two have to be separable. Registering late loses the opening beat — the guest schedules it
   * as soon as it is open, and on a cross-origin port nothing orders that against the host finishing
   * its own mount — which leaves a perfectly healthy fragment sitting in `connecting` for a full
   * interval. Arming early is the opposite mistake: it puts a deadline on a fragment that is still
   * evaluating its framework bundle, and the honest name for that state is `loading`.
   */
  armAfter?: Promise<unknown>;
}

export interface HostLiveness {
  readonly state: LivenessState;
  stop(): void;
}

/** Host side: watches for beats and reports what it can and cannot conclude from their absence. */
export function startHostLiveness(options: HostLivenessOptions): HostLiveness {
  const { channel, instance, signal } = options;
  const beatIntervalMs = options.beatIntervalMs ?? BEAT_INTERVAL_MS;
  const graceBeats = options.graceBeats ?? GRACE_BEATS;
  const goneAfterMs = options.goneAfterMs ?? GONE_AFTER_MS;
  const visibility = options.visibility ?? documentVisibility();

  let state: LivenessState = 'connecting';
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let goneTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const transition = (next: LivenessState) => {
    if (stopped || next === state) return;
    const previous = state;
    state = next;
    options.onState(next, previous);
  };

  const clearDeadline = () => {
    if (deadline !== undefined) clearTimeout(deadline);
    deadline = undefined;
  };

  const clearGone = () => {
    if (goneTimer !== undefined) clearTimeout(goneTimer);
    goneTimer = undefined;
  };

  const armDeadline = () => {
    clearDeadline();
    if (stopped || visibility.isHidden()) return;
    deadline = setTimeout(() => {
      transition('suspect');
      // Suspicion is reported but not acted on. A fragment doing a long synchronous render is
      // indistinguishable from one that has died, right up until it finishes — so the host says
      // what it observes and waits before it says what it concludes.
      clearGone();
      goneTimer = setTimeout(() => transition('gone'), goneAfterMs);
    }, beatIntervalMs * graceBeats);
  };

  channel.on(BEAT, (_payload, meta) => {
    /**
     * A beat only counts for the instance it came from.
     *
     * Without this, a fragment torn down mid-flight could have its last in-flight beat credited to
     * the instance that replaced it, and a replacement that never booted would look healthy for one
     * interval. (Today both ends of a trusted channel are stamped with the same instance by the
     * slot; Phase 5 binds this to the instance the fragment reports in ACCEPT.)
     */
    if (meta.instance !== instance) return;
    if (stopped) return;

    clearGone();
    transition(visibility.isHidden() ? 'unobservable' : 'healthy');
    armDeadline();
  });

  const detachVisibility = visibility.onChange(() => {
    if (stopped) return;
    if (visibility.isHidden()) {
      clearDeadline();
      clearGone();
      // Only a running fragment becomes unobservable. One already suspect or gone stays that way:
      // hiding the tab is not evidence of recovery.
      if (state === 'healthy' || state === 'connecting') transition('unobservable');
      return;
    }
    // Back in view: the deadline restarts from now rather than resuming, because the fragment has
    // only just been told it may beat again and has not had a chance to.
    armDeadline();
  });

  /**
   * Starting state depends on whether the fragment can be observed *right now*.
   *
   * `armDeadline()` alone is not enough, and the gap is easy to miss: it declines to arm while
   * hidden but transitions nothing, so a fragment that mounts into an already-hidden tab sits in
   * `connecting` indefinitely — indistinguishable, to a host, from one that never booted. Only the
   * `visibilitychange` handler below said `unobservable`, and a tab that was hidden before the
   * fragment existed never fires one.
   *
   * This is exactly the case a test that toggles visibility cannot reach, because toggling starts
   * from visible. It took a real browser — a backgrounded tab — to surface it.
   */
  const begin = () => {
    if (visibility.isHidden()) transition('unobservable');
    else armDeadline();
  };

  if (options.armAfter) {
    // Settled either way: a mount that failed still stops this from arming, because the slot tears
    // the instance down and the abort below runs.
    void options.armAfter.then(begin, begin);
  } else {
    begin();
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearDeadline();
    clearGone();
    detachVisibility();
  };

  signal.addEventListener('abort', stop, { once: true });

  return {
    get state() {
      return state;
    },
    stop,
  };
}

export interface FragmentBeatOptions {
  channel: BoundaryChannel;
  /** The realm's timer source — see `BeatScheduler`. */
  scheduler: BeatScheduler;
  signal: AbortSignal;
  beatIntervalMs?: number;
  visibility?: VisibilitySource;
}

/** Fragment side: beats while it can be observed, and stays quiet while it cannot. */
export function startFragmentBeats(options: FragmentBeatOptions): () => void {
  const { channel, scheduler, signal } = options;
  const beatIntervalMs = options.beatIntervalMs ?? BEAT_INTERVAL_MS;
  const visibility = options.visibility ?? documentVisibility();

  const beat = () => {
    // Suppressed rather than merely ignored by the host: a hidden tab's throttled beats would
    // arrive at unpredictable intervals, and a host that had to distinguish "throttled" from
    // "dying" from timing alone would guess wrong in both directions.
    if (visibility.isHidden()) return;
    channel.send(BEAT);
  };

  const timer = scheduler.setInterval(beat, beatIntervalMs);

  /**
   * An opening beat as well as the interval, so `connecting → healthy` costs one message rather
   * than one interval — a fragment that appears unwell for its first two seconds reads as a slow
   * fragment, and that impression is very hard to undo.
   *
   * Scheduled on the realm rather than called directly, even though calling it would be simpler and
   * would look identical in every passing test. A beat sent from host code is not evidence about
   * the realm, and one exception to that rule is all it takes for a realm that wedged during mount
   * to report `healthy` on the strength of a beat it never produced.
   */
  scheduler.setTimeout(beat, 0);

  const detachVisibility = visibility.onChange(() => {
    if (!visibility.isHidden()) scheduler.setTimeout(beat, 0);
  });

  const stop = () => {
    scheduler.clearInterval(timer);
    detachVisibility();
  };

  signal.addEventListener('abort', stop, { once: true });
  return stop;
}
