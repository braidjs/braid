import { versioned } from '@braidlabs/skew';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BraidError } from '../errors.js';
import { braidContext } from './context-bus.js';

/**
 * The bus's job is not fan-out — that part is a `Set` — it is delivering one published value to
 * subscribers who disagree about what it looks like.
 */

interface InstrumentV1 {
  ticker: string;
}
interface InstrumentV2 extends InstrumentV1 {
  market: string;
}

/** v2 carries the market identifier; v1 never had one, so projecting down discards it. */
const Instrument = versioned<InstrumentV1>('spec.instrument').next<InstrumentV2>(
  'carry the MIC market identifier alongside the ticker',
  {
    // Nothing to derive on the way up: a ticker does not determine a venue, and inventing one would
    // route an order to the wrong exchange.
    up: (v1) => ({ ...v1, market: '' }),
    down: ({ market: _market, ...rest }) => rest,
    lossy: ['market'],
  },
);

/** The same shape, with no way back — the case a subscription must be refused over. */
const OneWay = versioned<InstrumentV1>('spec.one-way').next<InstrumentV2>('add market, no inverse', (v1) => ({
  ...v1,
  market: '',
}));

afterEach(() => braidContext.clear());

describe('untyped keys', () => {
  it('delivers a clone, unchanged', () => {
    const seen = vi.fn();
    braidContext.subscribe('selection', seen);

    const value = { id: 'row-1' };
    braidContext.set('selection', value);

    expect(seen).toHaveBeenCalledWith({ id: 'row-1' });
    // Cloned at the boundary: a live object shared across realms is a retention leak and a coupling.
    expect(seen.mock.calls[0]![0]).not.toBe(value);
  });
});

describe('versioned delivery', () => {
  it('gives each subscriber the shape it asked for, from one broadcast', () => {
    braidContext.register('instrument', Instrument);
    const current = vi.fn();
    const behind = vi.fn();

    braidContext.subscribe('instrument', current);
    braidContext.subscribe('instrument', behind, { as: 1, fragmentId: 'blotter' });

    braidContext.set('instrument', { ticker: 'IBM', market: 'XNYS' });

    expect(current).toHaveBeenCalledWith({ ticker: 'IBM', market: 'XNYS' });
    // The older fragment gets the older shape. It never learns that a newer one exists.
    expect(behind).toHaveBeenCalledWith({ ticker: 'IBM' });
  });

  it('projects a read the same way it projects a delivery', () => {
    braidContext.register('instrument', Instrument);
    braidContext.set('instrument', { ticker: 'IBM', market: 'XNYS' });

    expect(braidContext.get('instrument')).toEqual({ ticker: 'IBM', market: 'XNYS' });
    expect(braidContext.get('instrument', { as: 1 })).toEqual({ ticker: 'IBM' });
  });

  it('leaves a key with no registered schema alone', () => {
    const seen = vi.fn();
    braidContext.subscribe('freeform', seen, { as: 1 });

    braidContext.set('freeform', { anything: true });

    expect(seen).toHaveBeenCalledWith({ anything: true });
  });
});

describe('refusing an unreachable version', () => {
  it('refuses at subscribe time, not mid-broadcast', () => {
    braidContext.register('instrument', OneWay);
    const served = vi.fn();
    braidContext.subscribe('instrument', served);

    expect(() => braidContext.subscribe('instrument', vi.fn(), { as: 1, fragmentId: 'blotter' })).toThrow(BraidError);

    // The point of refusing early: the broadcast that would have failed halfway still serves
    // everyone who was allowed to subscribe.
    braidContext.set('instrument', { ticker: 'IBM', market: 'XNYS' });
    expect(served).toHaveBeenCalledOnce();
  });

  it('names the fragment, the stage, and the step that has no way back', () => {
    braidContext.register('instrument', OneWay);

    let raised: BraidError | undefined;
    try {
      braidContext.subscribe('instrument', vi.fn(), { as: 1, fragmentId: 'blotter' });
    } catch (error) {
      raised = error as BraidError;
    }

    expect(raised?.stage).toBe('context-version');
    expect(raised?.fragmentId).toBe('blotter');
    expect(raised?.message).toContain('no down migration');
    expect(raised?.message).toContain('add market, no inverse');
    expect(raised?.fixHint).toContain('down migration');
  });

  it('refuses a subscriber that is ahead of the publisher', () => {
    braidContext.register('instrument', Instrument);

    expect(() => braidContext.subscribe('instrument', vi.fn(), { as: 5, fragmentId: 'blotter' })).toThrow(
      /published at v2, and this subscriber asked for v5/,
    );
  });

  it('refuses a read at a version it would refuse a subscription at', () => {
    braidContext.register('instrument', OneWay);
    braidContext.set('instrument', { ticker: 'IBM', market: 'XNYS' });

    expect(() => braidContext.get('instrument', { as: 1 })).toThrow(BraidError);
  });
});

describe('lifecycle', () => {
  it('stops delivering once unsubscribed, and on abort', () => {
    const manual = vi.fn();
    const aborted = vi.fn();
    const controller = new AbortController();

    const unsubscribe = braidContext.subscribe('selection', manual);
    braidContext.subscribe('selection', aborted, { signal: controller.signal });

    unsubscribe();
    controller.abort();
    braidContext.set('selection', { id: 'row-2' });

    expect(manual).not.toHaveBeenCalled();
    expect(aborted).not.toHaveBeenCalled();
  });

  it('accepts a schema registered after values were already published', () => {
    // The host learns a fragment's contract when the fragment mounts, which is later than the first
    // broadcast on every real page.
    braidContext.set('instrument', { ticker: 'IBM', market: 'XNYS' });
    braidContext.register('instrument', Instrument);

    expect(braidContext.get('instrument', { as: 1 })).toEqual({ ticker: 'IBM' });
  });
});

describe('one bad subscriber', () => {
  it('does not stop delivery to the others', () => {
    const before = vi.fn();
    const after = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    braidContext.subscribe('selection', before);
    braidContext.subscribe('selection', () => {
      throw new Error('this fragment has a bug');
    });
    braidContext.subscribe('selection', after);

    braidContext.set('selection', { id: 'row-1' });

    // Without isolation, one app's bad deploy presents as a *different* app silently not updating.
    expect(before).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('context subscriber threw'), expect.anything());

    errors.mockRestore();
  });

  it('keeps delivering after a subscriber whose version became unreachable', () => {
    // The chain is registered *after* the subscription, so subscribe-time validation could not have
    // caught it — this is the case that reaches the fan-out.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const healthy = vi.fn();

    braidContext.subscribe('instrument', vi.fn(), { as: 1 });
    braidContext.subscribe('instrument', healthy);
    braidContext.register('instrument', OneWay);

    braidContext.set('instrument', { ticker: 'IBM', market: 'XNYS' });

    expect(healthy).toHaveBeenCalledOnce();
    errors.mockRestore();
  });
});


describe('late subscribers', () => {
  it('replays the current value to a new subscriber, then every later change', () => {
    braidContext.set('session', { userId: 'u1' });
    const seen = vi.fn();

    braidContext.subscribe('session', seen);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenLastCalledWith({ userId: 'u1' });

    braidContext.set('session', { userId: 'u2' });
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenLastCalledWith({ userId: 'u2' });
  });

  it('replays at the version the subscriber asked for', () => {
    braidContext.register('instrument', Instrument);
    braidContext.set('instrument', { ticker: 'IBM', market: 'XNYS' });
    const behind = vi.fn();

    braidContext.subscribe('instrument', behind, { as: 1 });

    expect(behind).toHaveBeenCalledWith({ ticker: 'IBM' });
  });

  it('replays nothing for a key with no value yet, or when told not to', () => {
    braidContext.set('session', { userId: 'u1' });
    const optedOut = vi.fn();
    const empty = vi.fn();

    braidContext.subscribe('session', optedOut, { replay: false });
    braidContext.subscribe('promo', empty);

    expect(optedOut).not.toHaveBeenCalled();
    expect(empty).not.toHaveBeenCalled();
    braidContext.set('session', { userId: 'u2' });
    expect(optedOut).toHaveBeenCalledWith({ userId: 'u2' });
  });

  it('isolates a listener that throws on replay, and keeps it subscribed', () => {
    braidContext.set('session', { userId: 'u1' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let calls = 0;

    expect(() =>
      braidContext.subscribe(
        'session',
        () => {
          calls += 1;
          if (calls === 1) throw new Error('first render failed');
        },
        { replay: true },
      ),
    ).not.toThrow();
    braidContext.set('session', { userId: 'u2' });

    expect(calls).toBe(2);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('registers nothing for a subscription whose signal already aborted', () => {
    braidContext.set('session', { userId: 'u1' });
    const seen = vi.fn();
    const controller = new AbortController();
    controller.abort();

    braidContext.subscribe('session', seen, { replay: true, signal: controller.signal });
    braidContext.set('session', { userId: 'u2' });

    expect(seen).not.toHaveBeenCalled();
  });
});
