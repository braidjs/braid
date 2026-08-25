import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BraidError } from '../errors.js';
import { BoundaryChannel, createBoundaryChannel } from './channel.js';
import { createSameRealmBackingPair } from './same-realm-backing.js';
import { createPortBacking } from './port-backing.js';
import { CLOSE, ClosingCoordinator, DIRTY, DirtyPayload, closeFragment, createClosingCoordinator } from './closing.js';

const INSTANCE = 'instance-1';

interface Pair {
  host: BoundaryChannel;
  fragment: BoundaryChannel;
  closing: ClosingCoordinator;
  dispose(): void;
}

function pair(kind: 'same-realm' | 'port' = 'same-realm'): Pair {
  const signal = new AbortController().signal;
  const [hostBacking, fragmentBacking] =
    kind === 'port'
      ? (() => {
          const channel = new MessageChannel();
          return [createPortBacking(channel.port1), createPortBacking(channel.port2)] as const;
        })()
      : (() => {
          const backings = createSameRealmBackingPair();
          return [backings.host, backings.fragment] as const;
        })();

  const host = createBoundaryChannel({ backing: hostBacking, fragmentId: 'checkout', instance: INSTANCE, signal });
  const fragment = createBoundaryChannel({ backing: fragmentBacking, fragmentId: 'checkout', instance: INSTANCE, signal });

  return {
    host,
    fragment,
    closing: createClosingCoordinator(fragment),
    dispose() {
      host.close();
      fragment.close();
    },
  };
}

describe.each(['same-realm', 'port'] as const)('close negotiation over %s', (kind) => {
  it('runs the fragment’s closing work and reports what it flushed', async () => {
    const p = pair(kind);
    p.closing.onClosing(async () => {
      await Promise.resolve();
      return { flushed: 50, dropped: 0 };
    });

    // The done-when case: a fragment with a full outbox unmounts having flushed all of it.
    const result = await closeFragment({ channel: p.host, fragmentId: 'checkout', reason: 'unmount' });

    expect(result).toEqual({ acknowledged: true, flushed: 50, dropped: 0, deferred: 0 });
    p.dispose();
  });

  it('tells the fragment why it is closing', async () => {
    const p = pair(kind);
    const seen = vi.fn();
    p.closing.onClosing(seen);

    await closeFragment({ channel: p.host, fragmentId: 'checkout', reason: 'reload' });

    // A reload and an unmount call for different work: a draft worth persisting across a reload may
    // be worth discarding when the user navigated away deliberately.
    expect(seen).toHaveBeenCalledWith('reload');
    p.dispose();
  });
});

describe('close deadlines', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('proceeds when the fragment never acknowledges, and says so', async () => {
    const p = pair();
    p.closing.onClosing(() => new Promise(() => undefined));
    const onOverrun = vi.fn();

    const pending = closeFragment({
      channel: p.host,
      fragmentId: 'checkout',
      reason: 'unmount',
      deadlineMs: 2_000,
      onOverrun,
    });
    await vi.advanceTimersByTimeAsync(2_001);
    const result = await pending;

    // The second done-when case: a fragment that refuses to ACK is torn down anyway.
    expect(result.acknowledged).toBe(false);
    expect(onOverrun).toHaveBeenCalledTimes(1);

    const error = onOverrun.mock.calls[0]?.[0] as BraidError;
    expect(error).toBeInstanceOf(BraidError);
    expect(error.stage).toBe('teardown');
    expect(error.message).toContain('2000ms');
    p.dispose();
  });

  it('does not report zero drops when it could not see the answer', async () => {
    const p = pair();
    p.closing.onClosing(() => new Promise(() => undefined));

    const pending = closeFragment({
      channel: p.host,
      fragmentId: 'checkout',
      reason: 'unmount',
      deadlineMs: 100,
      onOverrun: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(101);
    const result = await pending;

    // `acknowledged: false` is what carries the meaning here — a `dropped: 0` read without it would
    // be a lie told in a reassuring tone.
    expect(result.acknowledged).toBe(false);
    p.dispose();
  });

  it('closes cleanly when the fragment has no closing work at all', async () => {
    const p = pair();
    const result = await closeFragment({ channel: p.host, fragmentId: 'checkout', reason: 'unmount' });

    expect(result).toEqual({ acknowledged: true, flushed: 0, dropped: 0, deferred: 0 });
    p.dispose();
  });
});

describe('multiple closing handlers', () => {
  it('aggregates their reports', async () => {
    const p = pair();
    p.closing.onClosing(() => ({ flushed: 3 }));
    p.closing.onClosing(() => ({ flushed: 2, dropped: 1 }));

    const result = await closeFragment({ channel: p.host, fragmentId: 'checkout', reason: 'unmount' });

    expect(result).toMatchObject({ flushed: 5, dropped: 1 });
    p.dispose();
  });

  it.each([
    ['synchronously', () => { throw new Error('indexeddb is gone'); }],
    ['asynchronously', async () => { throw new Error('indexeddb is gone'); }],
  ])('counts a handler that throws %s as a drop, and still runs the others', async (_how, thrower) => {
    const p = pair();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The synchronous case is the one that bites: a bare `.map(handler)` lets the throw escape
    // before `allSettled` sees it, rejecting the whole reply and losing the other handler's flush.
    p.closing.onClosing(thrower);
    p.closing.onClosing(() => ({ flushed: 4 }));

    const result = await closeFragment({ channel: p.host, fragmentId: 'checkout', reason: 'unmount' });

    // Conservative on purpose: a handler that threw did not flush what it was responsible for, and
    // any other reading overstates success.
    expect(result).toMatchObject({ acknowledged: true, flushed: 4, dropped: 1 });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
    p.dispose();
  });

  it('stops running a handler once it is unregistered', async () => {
    const p = pair();
    const seen = vi.fn();
    const off = p.closing.onClosing(seen);
    off();

    await closeFragment({ channel: p.host, fragmentId: 'checkout', reason: 'unmount' });

    expect(seen).not.toHaveBeenCalled();
    p.dispose();
  });
});

describe('dirty state', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('pushes as it changes, rather than being asked for at close time', async () => {
    const p = pair();
    const seen: Array<string | null> = [];
    p.host.on(DIRTY, (payload) => void seen.push(((payload ?? {}) as DirtyPayload).reason));

    p.closing.setDirty('an unsent order');
    await flush();

    // The host has the answer *before* anything starts closing — which is the only way it can be
    // answered inside a `beforeunload` handler, where nothing can be awaited.
    expect(seen).toEqual(['an unsent order']);
    expect(p.closing.dirty).toBe('an unsent order');
    p.dispose();
  });

  it('clears', async () => {
    const p = pair();
    const seen: Array<string | null> = [];
    p.host.on(DIRTY, (payload) => void seen.push(((payload ?? {}) as DirtyPayload).reason));

    p.closing.setDirty('an unsent order');
    p.closing.setDirty(null);
    await flush();

    expect(seen).toEqual(['an unsent order', null]);
    expect(p.closing.dirty).toBeNull();
    p.dispose();
  });

  it('does not re-announce an unchanged reason', async () => {
    const p = pair();
    const seen = vi.fn();
    p.host.on(DIRTY, seen);

    p.closing.setDirty('an unsent order');
    p.closing.setDirty('an unsent order');
    await flush();

    expect(seen).toHaveBeenCalledTimes(1);
    p.dispose();
  });
});

describe('protocol shape', () => {
  it('carries the deadline to the fragment, so it can budget its own flush', async () => {
    const p = pair();
    const seen = vi.fn(() => ({ flushed: 0 }));
    p.fragment.on(CLOSE, seen);

    await closeFragment({ channel: p.host, fragmentId: 'checkout', reason: 'navigate', deadlineMs: 750 });

    expect(seen).toHaveBeenCalledWith({ reason: 'navigate', deadlineMs: 750 }, expect.anything());
    p.dispose();
  });
});

describe('deferred work', () => {
  it('is reported apart from both flushed and dropped', async () => {
    const p = pair();
    // What an outbox reports when the network is down: nothing sent, nothing lost, three entries
    // still safely in storage waiting for the next boot.
    p.closing.onClosing(() => ({ flushed: 0, dropped: 0, deferred: 3 }));

    const result = await closeFragment({ channel: p.host, fragmentId: 'checkout', reason: 'unmount' });

    // Folded into `dropped` this would raise an alarm about data that is fine; folded into
    // `flushed` it would claim a write reached the server when it never left the device.
    expect(result).toMatchObject({ acknowledged: true, flushed: 0, dropped: 0, deferred: 3 });
    p.dispose();
  });
});
