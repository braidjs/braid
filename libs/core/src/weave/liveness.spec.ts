import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoundaryChannel, createBoundaryChannel } from './channel.js';
import { createSameRealmBackingPair } from './same-realm-backing.js';
import {
  BEAT,
  BeatScheduler,
  LivenessState,
  VisibilitySource,
  startFragmentBeats,
  startHostLiveness,
} from './liveness.js';

const INSTANCE = 'instance-1';
const BEAT_MS = 100;
const GRACE = 3;
const GONE_MS = 500;

/** A visibility source the test drives, standing in for the document both ends would consult. */
function testVisibility() {
  let hidden = false;
  const listeners = new Set<() => void>();
  return {
    source: {
      isHidden: () => hidden,
      onChange(listener: () => void) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    } satisfies VisibilitySource,
    set(next: boolean) {
      hidden = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * A scheduler the test can freeze independently of the host's timers — the realm's event loop.
 *
 * Being able to stop *this* without stopping the host's is the whole point: it is how a wedged
 * realm is reproduced, and a beat scheduled on host timers would keep arriving from a fragment that
 * had stopped executing.
 */
function realmScheduler() {
  let handler: (() => void) | undefined;
  let wedged = false;
  return {
    scheduler: {
      setInterval(next: () => void, _ms: number) {
        handler = next;
        return 1;
      },
      clearInterval() {
        handler = undefined;
      },
      setTimeout(next: () => void, _ms: number) {
        // Queued on the realm's loop, so a wedged realm never runs it — which is the difference
        // between the opening beat being evidence and being decoration.
        if (!wedged) queueMicrotask(next);
        return 2;
      },
    } satisfies BeatScheduler,
    /** One turn of the realm's event loop. */
    tick() {
      if (!wedged) handler?.();
    },
    /** The `while (true)` case: the realm stops running its timers. */
    wedge() {
      wedged = true;
    },
  };
}

interface Harness {
  states: LivenessState[];
  host: { readonly state: LivenessState; stop(): void };
  hostChannel: BoundaryChannel;
  fragmentChannel: BoundaryChannel;
  realm: ReturnType<typeof realmScheduler>;
  visibility: ReturnType<typeof testVisibility>;
  abort(): void;
}

function harness(options: { beats?: boolean; startHidden?: boolean } = {}): Harness {
  const controller = new AbortController();
  const signal = controller.signal;
  const backings = createSameRealmBackingPair();
  const hostChannel = createBoundaryChannel({ backing: backings.host, fragmentId: 'checkout', instance: INSTANCE, signal });
  const fragmentChannel = createBoundaryChannel({ backing: backings.fragment, fragmentId: 'checkout', instance: INSTANCE, signal });

  const visibility = testVisibility();
  if (options.startHidden) visibility.set(true);
  const realm = realmScheduler();
  const states: LivenessState[] = [];

  const host = startHostLiveness({
    channel: hostChannel,
    instance: INSTANCE,
    signal,
    beatIntervalMs: BEAT_MS,
    graceBeats: GRACE,
    goneAfterMs: GONE_MS,
    visibility: visibility.source,
    onState: (state) => states.push(state),
  });

  if (options.beats !== false) {
    startFragmentBeats({
      channel: fragmentChannel,
      scheduler: realm.scheduler,
      signal,
      beatIntervalMs: BEAT_MS,
      visibility: visibility.source,
    });
  }

  return { states, host, hostChannel, fragmentChannel, realm, visibility, abort: () => controller.abort() };
}

/** Lets queued messages cross while fake timers are installed. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('host liveness', () => {
  it('reaches healthy on the first beat, without waiting an interval', async () => {
    const h = harness();
    await settle();

    expect(h.host.state).toBe('healthy');
    expect(h.states).toEqual(['healthy']);
    h.abort();
  });

  it('stays healthy while the realm keeps beating', async () => {
    const h = harness();
    await settle();

    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(BEAT_MS);
      h.realm.tick();
      await settle();
    }

    expect(h.host.state).toBe('healthy');
    h.abort();
  });

  it('goes suspect, then gone, when the realm wedges', async () => {
    const h = harness();
    await settle();
    expect(h.host.state).toBe('healthy');

    // The case the whole phase exists for: the realm's event loop stops, so its timers stop, so
    // its beats stop — while the host's own timers keep running perfectly well.
    h.realm.wedge();

    await vi.advanceTimersByTimeAsync(BEAT_MS * GRACE + 1);
    expect(h.host.state).toBe('suspect');

    await vi.advanceTimersByTimeAsync(GONE_MS + 1);
    expect(h.host.state).toBe('gone');
    expect(h.states).toEqual(['healthy', 'suspect', 'gone']);
    h.abort();
  });

  it('recovers from suspect when a late beat arrives', async () => {
    const h = harness();
    await settle();
    h.realm.wedge();

    await vi.advanceTimersByTimeAsync(BEAT_MS * GRACE + 1);
    expect(h.host.state).toBe('suspect');

    // A long synchronous render is indistinguishable from death right up until it finishes.
    h.fragmentChannel.send(BEAT);
    await settle();

    expect(h.host.state).toBe('healthy');
    expect(h.states).toEqual(['healthy', 'suspect', 'healthy']);
    h.abort();
  });

  it('never reaches gone while suspicion is still recoverable', async () => {
    const h = harness();
    await settle();
    h.realm.wedge();
    await vi.advanceTimersByTimeAsync(BEAT_MS * GRACE + 1);

    // Beat just under the deadline, repeatedly: a slow-but-alive fragment must not be declared dead.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(GONE_MS - 10);
      h.fragmentChannel.send(BEAT);
      await settle();
    }

    expect(h.states).not.toContain('gone');
    h.abort();
  });

  it('ignores beats stamped with a different instance', async () => {
    const h = harness({ beats: false });
    const stale = createBoundaryChannel({
      backing: createSameRealmBackingPair().fragment,
      fragmentId: 'checkout',
      instance: 'instance-0',
    });
    stale.send(BEAT);
    await settle();

    expect(h.host.state).toBe('connecting');
    h.abort();
  });
});

describe('hidden tabs', () => {
  it('reports unobservable rather than suspect, and never reaches gone', async () => {
    const h = harness();
    await settle();
    expect(h.host.state).toBe('healthy');

    h.visibility.set(true);
    // Far longer than every deadline: a backgrounded tab must not accumulate suspicion.
    await vi.advanceTimersByTimeAsync(BEAT_MS * GRACE * 10 + GONE_MS * 10);

    expect(h.host.state).toBe('unobservable');
    expect(h.states).not.toContain('suspect');
    expect(h.states).not.toContain('gone');
    h.abort();
  });

  it('returns to healthy when the tab comes back', async () => {
    const h = harness();
    await settle();
    h.visibility.set(true);
    await vi.advanceTimersByTimeAsync(BEAT_MS * GRACE * 5);

    h.visibility.set(false);
    await settle();

    expect(h.host.state).toBe('healthy');
    expect(h.states).toEqual(['healthy', 'unobservable', 'healthy']);
    h.abort();
  });

  it('gives the fragment a fresh deadline on return, not a resumed one', async () => {
    const h = harness();
    await settle();
    h.visibility.set(true);
    await vi.advanceTimersByTimeAsync(BEAT_MS * GRACE * 5);

    // Back in view and immediately wedged: the fragment has had no chance to beat, so the host
    // must start counting from now rather than concluding from time that passed while hidden.
    h.realm.wedge();
    h.visibility.set(false);
    await vi.advanceTimersByTimeAsync(BEAT_MS * GRACE - 10);
    expect(h.host.state).not.toBe('suspect');

    await vi.advanceTimersByTimeAsync(20);
    expect(h.host.state).toBe('suspect');
    h.abort();
  });

  it('stays suspect when hidden, rather than being excused by it', async () => {
    const h = harness();
    await settle();
    h.realm.wedge();
    await vi.advanceTimersByTimeAsync(BEAT_MS * GRACE + 1);
    expect(h.host.state).toBe('suspect');

    h.visibility.set(true);
    await settle();

    // Hiding the tab is not evidence of recovery.
    expect(h.host.state).toBe('suspect');
    h.abort();
  });

  it('sends no beats while hidden', async () => {
    const h = harness();
    await settle();
    const seen = vi.fn();
    h.hostChannel.on(BEAT, seen);
    seen.mockClear();

    h.visibility.set(true);
    for (let i = 0; i < 5; i++) {
      h.realm.tick();
      await settle();
    }

    expect(seen).not.toHaveBeenCalled();
    h.abort();
  });
});

describe('teardown', () => {
  it('stops watching when the instance signal aborts', async () => {
    const h = harness();
    await settle();
    h.abort();
    const before = h.states.length;

    await vi.advanceTimersByTimeAsync(BEAT_MS * GRACE + GONE_MS + 100);

    // A torn-down fragment is not a dead one, and must not be reported as gone.
    expect(h.states.length).toBe(before);
    h.abort();
  });
});

describe('a realm that wedges during mount', () => {
  it('never reports healthy, because it never produced a beat', async () => {
    const h = harness({ beats: false });
    const realm = realmScheduler();
    realm.wedge();
    startFragmentBeats({
      channel: h.fragmentChannel,
      scheduler: realm.scheduler,
      signal: new AbortController().signal,
      beatIntervalMs: BEAT_MS,
      visibility: h.visibility.source,
    });

    await settle();
    // The opening beat is scheduled on the realm, so a realm that never runs never sends one.
    // Had it been sent from host code, this fragment would have reported healthy.
    expect(h.host.state).toBe('connecting');

    await vi.advanceTimersByTimeAsync(BEAT_MS * GRACE + 1);
    expect(h.host.state).toBe('suspect');
    h.abort();
  });
});

describe('mounting into an already-hidden tab', () => {
  it('reports unobservable rather than sitting in connecting', async () => {
    const h = harness({ startHidden: true });
    await settle();

    /**
     * The bug a real browser found and this suite could not.
     *
     * Every visibility test here toggles, and toggling starts from visible — so the
     * `visibilitychange` handler always ran. A tab that was already hidden when the fragment
     * mounted never fires one, and the host had nothing else that consulted visibility. It sat in
     * `connecting` forever, which a host cannot tell apart from a fragment that never booted.
     */
    expect(h.host.state).toBe('unobservable');
    h.abort();
  });

  it('never escalates to suspect while it stays hidden', async () => {
    const h = harness({ startHidden: true });
    await vi.advanceTimersByTimeAsync(BEAT_MS * GRACE * 10 + GONE_MS * 10);

    expect(h.states).not.toContain('suspect');
    expect(h.states).not.toContain('gone');
    h.abort();
  });

  it('reaches healthy once the tab is shown', async () => {
    const h = harness({ startHidden: true });
    await settle();

    h.visibility.set(false);
    await settle();

    expect(h.host.state).toBe('healthy');
    h.abort();
  });
});
