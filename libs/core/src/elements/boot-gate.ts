import { isDevMode } from '../config.js';

/**
 * When a slot boots its fragment: at once (`eager`, the default), or on intent.
 *
 * - `idle` — when the browser next has nothing better to do, or after two seconds regardless.
 * - `visible` — when the slot comes within 200px of the viewport.
 * - `interaction` — on the first pointer, key, or focus inside a pierced slot. The content is
 *   already painted, so the user has something to interact with; the fragment's code is what
 *   waits. A slot that was not pierced has nothing on screen to interact with, so it boots when
 *   visible instead.
 *
 * Deferring a boot defers all of it — the realm iframe, the document fetch, the fragment's
 * framework and app — which is more than lazy hydration can defer inside one framework.
 */
export type BootMode = 'eager' | 'idle' | 'visible' | 'interaction';

const BOOT_MODES: readonly BootMode[] = ['eager', 'idle', 'visible', 'interaction'];

/** Events that start an `interaction` boot. Of these, only clicks and submits are held. */
const INTENT_EVENTS = ['pointerdown', 'touchstart', 'keydown', 'focusin', 'click', 'submit'] as const;

/** Held at most this many, so a user hammering a dead button cannot queue an avalanche. */
const MAX_HELD = 10;

/** How far outside the viewport a `visible` slot starts booting. */
const VISIBLE_MARGIN = '200px';

/** The longest an `idle` boot waits for the browser to go idle. */
const IDLE_TIMEOUT_MS = 2_000;

export function parseBootMode(value: string | null, fragmentId: string): BootMode {
  if (value === null || value === '') return 'eager';
  if ((BOOT_MODES as readonly string[]).includes(value)) return value as BootMode;
  console.warn(`[braid:${fragmentId}] unknown boot="${value}", booting eagerly; expected one of ${BOOT_MODES.join(', ')}`);
  return 'eager';
}

export interface BootGate {
  /** Resolves when the slot should boot. Never rejects; never resolves after `dispose()`. */
  readonly triggered: Promise<void>;
  /**
   * Re-dispatches the clicks and submits that arrived before the fragment could handle them, on
   * their original targets, and stops holding. Called once the fragment is ready.
   */
  replay(): void;
  /** Stops waiting and drops anything held. */
  dispose(): void;
}

interface HeldEvent {
  target: Node;
  /** A click's init, or the submitter of a submit. */
  click?: MouseEventInit;
  submitter?: HTMLElement | null;
}

/**
 * Waits for a slot's boot trigger, holding what the user did in the meantime.
 *
 * Clicks and submits inside the slot are the events whose default action goes wrong without the
 * fragment's code — a link followed, a form posted — so until the fragment is ready they are
 * cancelled, kept, and replayed. Every other event is left alone: typed text and focus are already
 * in the DOM, which the fragment adopts in place.
 *
 * The listeners are on the slot's own shadow root, never on the host's `window` or `document`, so
 * an idle page carries nothing of Braid's.
 */
export function createBootGate(
  slot: HTMLElement,
  mode: BootMode,
  options: { pierced: boolean; fragmentId: string },
): BootGate {
  const held: HeldEvent[] = [];
  let stopTrigger: () => void = () => undefined;
  let stopHolding: () => void = () => undefined;
  let done = false;
  let fire!: () => void;

  const triggered = new Promise<void>((resolve) => {
    fire = () => {
      if (done) return;
      stopTrigger();
      stopTrigger = () => undefined;
      resolve();
    };
  });

  const root = slot.shadowRoot;
  const effective: BootMode = mode === 'interaction' && !(options.pierced && root) ? 'visible' : mode;

  if (effective === 'eager') {
    fire();
  } else if (effective === 'idle') {
    if (typeof requestIdleCallback === 'function') {
      const handle = requestIdleCallback(() => fire(), { timeout: IDLE_TIMEOUT_MS });
      stopTrigger = () => cancelIdleCallback(handle);
    } else {
      // Safari has no requestIdleCallback; after the current work is the closest equivalent
      const handle = setTimeout(() => fire(), 0);
      stopTrigger = () => clearTimeout(handle);
    }
  } else if (effective === 'visible') {
    if (typeof IntersectionObserver !== 'function') {
      fire();
    } else {
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) fire();
        },
        { rootMargin: VISIBLE_MARGIN },
      );
      observer.observe(slot);
      stopTrigger = () => observer.disconnect();
    }
  } else {
    const onIntent = (event: Event) => {
      if (event.type === 'click' || event.type === 'submit') hold(event);
      fire();
    };
    // Kept until replay, not only until the trigger: a second click while the fragment boots
    // needs holding as much as the first.
    for (const type of INTENT_EVENTS) root!.addEventListener(type, onIntent, { capture: true });
    stopHolding = () => {
      for (const type of INTENT_EVENTS) root!.removeEventListener(type, onIntent, { capture: true });
    };
  }

  function hold(event: Event): void {
    const target = event.composedPath()[0] as Node | undefined;
    if (!target) return;
    event.preventDefault();
    // The fragment's own handlers do not exist yet, and the host should see this action once —
    // when it is replayed — rather than once cancelled and again for real.
    event.stopPropagation();
    if (held.length >= MAX_HELD) return;
    held.push(
      event.type === 'submit'
        ? { target, submitter: (event as SubmitEvent).submitter ?? null }
        : { target, click: mouseInit(event as MouseEvent) },
    );
  }

  function finish(): void {
    done = true;
    stopTrigger();
    stopHolding();
  }

  return {
    triggered,
    replay() {
      if (done) return;
      finish();
      for (const entry of held.splice(0)) {
        if (!entry.target.isConnected) {
          if (isDevMode()) {
            console.warn(
              `[braid:${options.fragmentId}] an action taken before boot was dropped: its element left the ` +
                `DOM while the fragment booted, so the fragment re-rendered instead of adopting its markup`,
            );
          }
          continue;
        }
        if (entry.click) entry.target.dispatchEvent(new MouseEvent('click', entry.click));
        else (entry.target as HTMLFormElement).requestSubmit(entry.submitter ?? undefined);
      }
    },
    dispose() {
      finish();
      held.length = 0;
    },
  };
}

function mouseInit(event: MouseEvent): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    detail: event.detail,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    button: event.button,
    buttons: event.buttons,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
  };
}
