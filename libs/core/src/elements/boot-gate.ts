import { isDevMode } from '../config.js';

/**
 * When a slot boots its fragment: at once (`eager`, the default), or on intent.
 *
 * - `idle` — once the page has loaded and the browser next has nothing better to do, or two
 *   seconds after load regardless.
 * - `visible` — when the slot comes within one viewport of being on screen.
 * - `interaction` — on the first hover, pointer, key, or focus inside a pierced slot. The content
 *   is already painted, so the user has something to interact with; the fragment's code is what
 *   waits. A slot that was not pierced has nothing on screen to interact with, so it boots when
 *   visible instead.
 *
 * Deferring a boot defers all of it — the realm iframe, the document fetch, the fragment's
 * framework and app — which is more than lazy hydration can defer inside one framework.
 */
export type BootMode = 'eager' | 'idle' | 'visible' | 'interaction';

const BOOT_MODES: readonly BootMode[] = ['eager', 'idle', 'visible', 'interaction'];

/** Events that start an `interaction` boot. Only `click` and `submit` are ever cancelled. */
const PASSIVE_INTENT_EVENTS = ['pointerover', 'pointerdown', 'touchstart', 'keydown', 'focusin'] as const;
const HELD_EVENTS = ['click', 'submit'] as const;

/** Held at most this many, so a user hammering a dead button cannot queue an avalanche. */
const MAX_HELD = 10;

/**
 * How far outside the viewport a `visible` slot starts booting. A boot is a network round trip and
 * an iframe, so it needs more lead than an image does; a smaller margin shows the skeleton on any
 * brisk scroll.
 */
const VISIBLE_MARGIN = '100%';

/** The longest an `idle` boot waits, after load, for the browser to go idle. */
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
   * their original targets, one per task, and stops holding. Called once the fragment is ready.
   */
  replay(): void;
  /** Stops waiting and holding, and drops anything held — the fragment will not be handling it. */
  dispose(): void;
}

interface HeldEvent {
  target: Node;
  /** A click's init; absent for a submit. */
  click?: MouseEventInit;
  submitter?: HTMLElement | null;
}

/**
 * Waits for a slot's boot trigger, holding what the user did in the meantime.
 *
 * Clicks and submits inside the slot are the events whose default action goes wrong without the
 * fragment's code — a link followed, a form posted — so until the fragment is ready they are
 * cancelled, kept, and replayed. At most one per element is kept, so three anxious clicks on "Pay"
 * become one. Every other event is left alone, and listened to passively: typed text and focus are
 * already in the DOM, which the fragment adopts in place.
 *
 * A replay is a synthetic event, some time after the real one, so what needs a fresh user gesture —
 * `window.open`, a file picker, the clipboard — will not work from it.
 *
 * The listeners are on the slot's own shadow root, never on the host's `window` or `document`. The
 * one exception is `idle`, which waits for the host window's `load` once, if the page has not
 * loaded yet.
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
    let cancel: () => void = () => undefined;
    const whenIdle = () => {
      if (typeof requestIdleCallback === 'function') {
        const handle = requestIdleCallback(() => fire(), { timeout: IDLE_TIMEOUT_MS });
        cancel = () => cancelIdleCallback(handle);
      } else {
        // Safari has no requestIdleCallback: a moment after load is the closest equivalent
        const handle = setTimeout(() => fire(), 200);
        cancel = () => clearTimeout(handle);
      }
    };
    // idle during page load is time the page's own content needs
    if (document.readyState === 'complete') whenIdle();
    else {
      addEventListener('load', whenIdle, { once: true });
      cancel = () => removeEventListener('load', whenIdle);
    }
    stopTrigger = () => cancel();
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
    const shadow = root!;
    // After the next paint, so the boot's work does not land in the frame that answers the
    // interaction that started it — which is the frame INP measures.
    const fireAfterPaint = () => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(fire, 0));
      else setTimeout(fire, 0);
    };
    const onIntent = () => fireAfterPaint();
    const onHeld = (event: Event) => {
      hold(event);
      fireAfterPaint();
    };
    for (const type of PASSIVE_INTENT_EVENTS) shadow.addEventListener(type, onIntent, { capture: true, passive: true });
    // Kept until replay, not only until the trigger: a click while the fragment boots needs
    // holding as much as the first.
    for (const type of HELD_EVENTS) shadow.addEventListener(type, onHeld, { capture: true });
    stopHolding = () => {
      for (const type of PASSIVE_INTENT_EVENTS) shadow.removeEventListener(type, onIntent, { capture: true });
      for (const type of HELD_EVENTS) shadow.removeEventListener(type, onHeld, { capture: true });
    };
  }

  function hold(event: Event): void {
    const target = event.composedPath()[0] as Node | undefined;
    if (!target) return;
    event.preventDefault();
    // The fragment's own handlers do not exist yet, and the host's bubbling listeners should see
    // this action once — when it is replayed — rather than once cancelled and again for real.
    event.stopPropagation();
    if (held.length >= MAX_HELD || held.some((entry) => entry.target === target)) return;
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

  function replayOne(entry: HeldEvent): void {
    if (!entry.target.isConnected) {
      if (isDevMode()) {
        console.warn(
          `[braid:${options.fragmentId}] an action taken before boot was dropped: its element left the ` +
            `DOM while the fragment booted, so the fragment re-rendered instead of adopting its markup`,
        );
      }
      return;
    }
    try {
      if (entry.click) {
        entry.target.dispatchEvent(new MouseEvent('click', entry.click));
      } else {
        const form = entry.target as HTMLFormElement;
        // a submitter the fragment replaced is no longer this form's, and requestSubmit would throw
        const submitter = entry.submitter?.isConnected && (entry.submitter as HTMLButtonElement).form === form ? entry.submitter : undefined;
        form.requestSubmit(submitter);
      }
    } catch (error) {
      console.warn(`[braid:${options.fragmentId}] replaying an action taken before boot failed`, error);
    }
  }

  return {
    triggered,
    replay() {
      if (done) return;
      finish();
      const queue = held.splice(0);
      // One per task, so each handler's own re-render — a button disabling itself — lands first.
      const next = () => {
        const entry = queue.shift();
        if (!entry) return;
        replayOne(entry);
        if (queue.length) setTimeout(next, 0);
      };
      next();
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
