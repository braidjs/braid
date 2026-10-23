import { versioned } from '@braidlabs/skew';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from './events.js';
import { createInvalidator, resetSharedInvalidators, type BroadcastChannelLike } from './invalidation.js';
import { memoryRecordDriver } from './memory-driver.js';
import { NoIntentHandlerError } from './intents.js';

/**
 * Eventing across applications: state, occurrences, durable queues, and conflict.
 *
 * The durable tests are the ones that matter, because they are the claim the plan rests on — an event
 * emitted while a consumer was not running is delivered when it arrives.
 */

interface OrderV1 {
  id: string;
  quantity: number;
}
interface OrderV2 extends OrderV1 {
  currency: string;
}

const Order = versioned<OrderV1>('bus.order').next<OrderV2>('carry the currency', {
  up: (v1) => ({ ...v1, currency: 'GBP' }),
  down: ({ currency: _currency, ...rest }) => rest,
  lossy: ['currency'],
});

/** A pair of BroadcastChannels wired to each other — one page, two realms, or two tabs. */
function wirePair(): (name: string) => BroadcastChannelLike {
  const listeners = new Map<string, Set<(event: { data: unknown }) => void>>();
  let side = 0;

  return (name: string) => {
    const mine = `${name}#${side++}`;
    listeners.set(mine, new Set());
    return {
      // Never delivers to its own sender, which is what a real BroadcastChannel does.
      postMessage: (message) => {
        for (const [key, set] of listeners) {
          if (key === mine || !key.startsWith(`${name}#`)) continue;
          set.forEach((listener) => listener({ data: message }));
        }
      },
      addEventListener: (_type, listener) => void listeners.get(mine)!.add(listener),
      close: () => listeners.delete(mine),
    };
  };
}

afterEach(() => resetSharedInvalidators());

describe('state, which is not an event', () => {
  it('gives a late subscriber the current value', () => {
    const bus = createEventBus({ consumer: 'checkout', invalidator: createInvalidator({ partition: 'p' }) });
    const selection = bus.channel<{ id: string }>('selection');

    selection.broadcast({ id: 'row-1' });

    const seen = vi.fn();
    selection.subscribe(seen);

    // The half of FDC3's broadcast that genuinely is state: what is true now.
    expect(seen).toHaveBeenCalledWith({ id: 'row-1' });
    bus.close();
  });

  it('projects state to each subscriber\'s version', () => {
    const bus = createEventBus({ consumer: 'checkout', invalidator: createInvalidator({ partition: 'p' }) });
    bus.register('orders', Order);
    const orders = bus.channel<OrderV2>('orders');

    const current = vi.fn();
    const behind = vi.fn();
    orders.subscribe(current);
    orders.subscribe(behind as never, { as: 1 });

    orders.broadcast({ id: 'o1', quantity: 2, currency: 'GBP' });

    expect(current).toHaveBeenCalledWith({ id: 'o1', quantity: 2, currency: 'GBP' });
    expect(behind).toHaveBeenCalledWith({ id: 'o1', quantity: 2 });
    bus.close();
  });

  it('raises a conflict when this app overwrites its own state with something else', () => {
    const bus = createEventBus({ consumer: 'checkout', invalidator: createInvalidator({ partition: 'p' }) });
    const selection = bus.channel<{ id: string; note?: string }>('selection');

    selection.broadcast({ id: 'row-1' });
    selection.broadcast({ id: 'row-2' });

    // Same words as a mutation's confirmation, deliberately: one conflict vocabulary per product.
    expect(selection.conflict()?.paths).toEqual(['id']);
    selection.acknowledgeConflict();
    expect(selection.conflict()).toBeNull();
    bus.close();
  });

  it('lets a resolver decide what is stored', () => {
    const bus = createEventBus({ consumer: 'checkout', invalidator: createInvalidator({ partition: 'p' }) });
    const counter = bus.channel<{ count: number }>('counter', {
      onConflict: (conflict) => ({ count: Math.max((conflict.expected as { count: number }).count, (conflict.actual as { count: number }).count) }),
    });

    counter.broadcast({ count: 5 });
    counter.broadcast({ count: 3 });

    expect(counter.state()).toEqual({ count: 5 });
    expect(counter.conflict()).toBeNull();
    bus.close();
  });

  it('isolates a throwing subscriber', () => {
    const errors: string[] = [];
    const bus = createEventBus({
      consumer: 'checkout',
      invalidator: createInvalidator({ partition: 'p' }),
      onEventError: (message) => errors.push(message),
    });
    const selection = bus.channel('selection');
    const healthy = vi.fn();

    selection.subscribe(() => {
      throw new Error('this app has a bug');
    });
    selection.subscribe(healthy);
    selection.broadcast({ id: 'row-1' });

    expect(healthy).toHaveBeenCalledOnce();
    expect(errors[0]).toContain('state subscriber threw');
    bus.close();
  });
});

describe('at-most-once events', () => {
  it('reaches handlers in this context', async () => {
    const bus = createEventBus({ consumer: 'checkout', invalidator: createInvalidator({ partition: 'p' }) });
    const orders = bus.channel('orders');
    const handled = vi.fn();

    orders.addEventListener('order.placed', handled);
    await orders.emit('order.placed', { id: 'o1' });

    expect(handled).toHaveBeenCalledWith(expect.objectContaining({ type: 'order.placed', source: 'checkout' }));
    bus.close();
  });

  it('does not reach a handler that was not listening yet', async () => {
    const bus = createEventBus({ consumer: 'checkout', invalidator: createInvalidator({ partition: 'p' }) });
    const orders = bus.channel('orders');

    await orders.emit('order.placed', { id: 'o1' });

    const late = vi.fn();
    orders.addEventListener('order.placed', late);

    // An occurrence is not state. Nothing replays it — which is exactly why at-least-once exists.
    expect(late).not.toHaveBeenCalled();
    bus.close();
  });

  it('crosses to another context on an origin-scoped channel', async () => {
    const wire = wirePair();
    const one = createEventBus({
      consumer: 'checkout',
      invalidator: createInvalidator({ partition: 'p' }),
      broadcastChannel: wire,
    });
    const two = createEventBus({
      consumer: 'account',
      invalidator: createInvalidator({ partition: 'p' }),
      broadcastChannel: wire,
    });

    const handled = vi.fn();
    two.channel('orders', { scope: 'origin' }).addEventListener('order.placed', handled);
    await one.channel('orders', { scope: 'origin' }).emit('order.placed', { id: 'o1' });

    expect(handled).toHaveBeenCalledOnce();
    one.close();
    two.close();
  });

  it('keeps a page-scoped channel out of other pages — another tab', async () => {
    const wire = wirePair();
    const one = createEventBus({ consumer: 'checkout', invalidator: createInvalidator({ partition: 'p' }), broadcastChannel: wire, page: 'tab-1' });
    const two = createEventBus({ consumer: 'account', invalidator: createInvalidator({ partition: 'p' }), broadcastChannel: wire, page: 'tab-2' });

    const handled = vi.fn();
    const state = vi.fn();
    two.channel('selection').addEventListener('row.clicked', handled);
    two.channel('selection').subscribe(state);
    await one.channel('selection').emit('row.clicked', { id: 'row-1' });
    one.channel('selection').broadcast({ id: 'row-1' });

    // Scope is per channel so a UI selection does not end up in five tabs.
    expect(handled).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
    one.close();
    two.close();
  });

  it('carries a page-scoped channel between the realms of one page', async () => {
    // two fragments on one page: separate JavaScript contexts, as isolated in memory as two tabs
    const wire = wirePair();
    const one = createEventBus({ consumer: 'checkout', invalidator: createInvalidator({ partition: 'p' }), broadcastChannel: wire, page: 'tab-1' });
    const two = createEventBus({ consumer: 'account', invalidator: createInvalidator({ partition: 'p' }), broadcastChannel: wire, page: 'tab-1' });

    const handled = vi.fn();
    const state = vi.fn();
    two.channel('selection').addEventListener('row.clicked', handled);
    two.channel('selection').subscribe(state);
    await one.channel('selection').emit('row.clicked', { id: 'row-1' });
    one.channel('selection').broadcast({ id: 'row-2' });

    expect(handled).toHaveBeenCalledWith(expect.objectContaining({ payload: { id: 'row-1' } }));
    expect(state).toHaveBeenCalledWith({ id: 'row-2' });
    one.close();
    two.close();
  });

  it('stays within this bus when there is no page to share, as outside a browser', () => {
    const wire = wirePair();
    const one = createEventBus({ consumer: 'checkout', invalidator: createInvalidator({ partition: 'p' }), broadcastChannel: wire });
    const two = createEventBus({ consumer: 'account', invalidator: createInvalidator({ partition: 'p' }), broadcastChannel: wire });
    const state = vi.fn();

    two.channel('selection').subscribe(state);
    one.channel('selection').broadcast({ id: 'row-1' });

    expect(state).not.toHaveBeenCalled();
    one.close();
    two.close();
  });
});

describe('which page a bus is on, by default', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A bus in a context whose top-level document started at `timeOrigin`. */
  function busUnder(top: unknown, wire: (name: string) => BroadcastChannelLike, consumer: string) {
    vi.stubGlobal('window', { top });
    return createEventBus({ consumer, invalidator: createInvalidator({ partition: 'p' }), broadcastChannel: wire });
  }

  it('is the top-level document, so realms under one top share page scope and other tabs do not', () => {
    const wire = wirePair();
    const realmA = busUnder({ performance: { timeOrigin: 1000.5 } }, wire, 'a');
    const realmB = busUnder({ performance: { timeOrigin: 1000.5 } }, wire, 'b');
    const otherTab = busUnder({ performance: { timeOrigin: 2000.25 } }, wire, 'c');
    const inB = vi.fn();
    const inOtherTab = vi.fn();
    realmB.channel('selection').subscribe(inB);
    otherTab.channel('selection').subscribe(inOtherTab);

    realmA.channel('selection').broadcast({ id: 'row-1' });

    expect(inB).toHaveBeenCalledWith({ id: 'row-1' });
    expect(inOtherTab).not.toHaveBeenCalled();
    [realmA, realmB, otherTab].forEach((bus) => bus.close());
  });

  it('falls back to this document when the top one cannot be read', () => {
    const crossOrigin = {
      get performance(): never {
        throw new DOMException('Blocked a frame from accessing a cross-origin frame', 'SecurityError');
      },
    };

    expect(() => busUnder(crossOrigin, wirePair(), 'a').close()).not.toThrow();
  });
});

describe('a context that opens a channel late', () => {
  it.each([
    ['an origin-scoped channel, in another tab', { scope: 'origin' as const }, {}],
    ['a page-scoped channel, in another realm', {}, { page: 'tab-1' }],
  ])('receives %s its current state without a new broadcast', (_, channelOptions, busOptions) => {
    const wire = wirePair();
    const one = createEventBus({ consumer: 'checkout', invalidator: createInvalidator({ partition: 'p' }), broadcastChannel: wire, ...busOptions });
    one.channel('session', channelOptions).broadcast({ userId: 'u1' });

    // the account panel mounts later — a lazy route, a fragment loaded on demand, a new tab
    const two = createEventBus({ consumer: 'account', invalidator: createInvalidator({ partition: 'p' }), broadcastChannel: wire, ...busOptions });
    const seen = vi.fn();
    two.channel('session', channelOptions).subscribe(seen);

    expect(seen).toHaveBeenCalledWith({ userId: 'u1' });
    expect(two.channel('session', channelOptions).state()).toEqual({ userId: 'u1' });
    one.close();
    two.close();
  });

  it('does not let a late reply set back a newer value it already has', () => {
    const wire = wirePair();
    const one = createEventBus({ consumer: 'checkout', invalidator: createInvalidator({ partition: 'p' }), broadcastChannel: wire, page: 'tab-1' });
    const two = createEventBus({ consumer: 'account', invalidator: createInvalidator({ partition: 'p' }), broadcastChannel: wire, page: 'tab-1' });
    two.channel('session').broadcast({ userId: 'new' });

    // a third context answers a state request with what it held before the newer broadcast
    const stale = wire('skew:events:default:page:tab-1:session');
    stale.postMessage({ kind: 'state-reply', value: { userId: 'old' } });

    expect(two.channel('session').state()).toEqual({ userId: 'new' });
    expect(one.channel('session').state()).toEqual({ userId: 'new' });
    one.close();
    two.close();
  });
});

describe('at-least-once events', () => {
  const setup = (driver = memoryRecordDriver()) => ({ driver, consumers: ['checkout', 'account'] });

  it('delivers to a consumer that was not running when it was emitted', async () => {
    const { driver, consumers } = setup();

    // The emitter. The account panel does not exist yet.
    const checkout = createEventBus({
      consumer: 'checkout',
      driver,
      consumers,
      invalidator: createInvalidator({ partition: 'p' }),
    });
    await checkout.channel('orders').emit('order.placed', { id: 'o1' }, { delivery: 'at-least-once' });
    checkout.close();

    // The account panel mounts later — a lazy route, another tab, a reload.
    const account = createEventBus({
      consumer: 'account',
      driver,
      consumers,
      invalidator: createInvalidator({ partition: 'p' }),
    });
    const handled = vi.fn();
    account.channel('orders').addEventListener('order.placed', handled);

    const flushed = await account.flush();

    expect(flushed.sent).toBe(1);
    expect(handled).toHaveBeenCalledWith(expect.objectContaining({ type: 'order.placed' }));
    account.close();
  });

  it('keeps the event queued until it is handled, and deletes it after', async () => {
    const { driver, consumers } = setup();
    const bus = createEventBus({ consumer: 'account', driver, consumers, invalidator: createInvalidator({ partition: 'p' }) });

    await bus.channel('orders').emit('order.placed', { id: 'o1' }, { delivery: 'at-least-once' });

    // No handler registered: nothing can consume it, so it waits rather than being dropped.
    expect((await bus.flush()).remaining).toBe(1);

    bus.channel('orders').addEventListener('order.placed', vi.fn());
    expect((await bus.flush()).sent).toBe(1);
    // Deletion on success *is* the acknowledgement — no separate ack bookkeeping exists.
    expect((await bus.flush()).remaining).toBe(0);
    bus.close();
  });

  it('retries a handler that threw, rather than losing the event', async () => {
    const { driver, consumers } = setup();
    const bus = createEventBus({ consumer: 'account', driver, consumers, invalidator: createInvalidator({ partition: 'p' }) });
    let attempts = 0;

    bus.channel('orders').addEventListener('order.placed', () => {
      attempts += 1;
      if (attempts < 3) throw new Error('not ready');
    });

    // The emit wakes the bus, so a flush has already run and failed by the time we get here — the
    // property under test is that the event survives that, not how many attempts it took.
    await bus.channel('orders').emit('order.placed', { id: 'o1' }, { delivery: 'at-least-once' });

    let result = await bus.flush();
    while (result.remaining > 0 && attempts < 5) result = await bus.flush();

    expect(attempts).toBe(3);
    expect(result.remaining).toBe(0);
    bus.close();
  });

  it('does not let one stuck consumer block another', async () => {
    const { driver, consumers } = setup();
    const emitter = createEventBus({ consumer: 'checkout', driver, consumers, invalidator: createInvalidator({ partition: 'p' }) });
    await emitter.channel('orders').emit('order.placed', { id: 'o1' }, { delivery: 'at-least-once' });
    emitter.close();

    const stuck = createEventBus({ consumer: 'checkout', driver, consumers, invalidator: createInvalidator({ partition: 'p' }) });
    stuck.channel('orders').addEventListener('order.placed', () => {
      throw new Error('permanently broken');
    });
    await stuck.flush();

    const healthy = createEventBus({ consumer: 'account', driver, consumers, invalidator: createInvalidator({ partition: 'p' }) });
    const handled = vi.fn();
    healthy.channel('orders').addEventListener('order.placed', handled);

    // One queue per consumer, so head-of-line blocking is per consumer too — the whole reason the
    // design is fan-out-at-emit rather than one entry with an ack set.
    expect((await healthy.flush()).sent).toBe(1);
    expect(handled).toHaveBeenCalledOnce();

    stuck.close();
    healthy.close();
  });

  it('refuses at-least-once without storage instead of silently downgrading', async () => {
    const bus = createEventBus({ consumer: 'checkout', invalidator: createInvalidator({ partition: 'p' }) });

    await expect(
      bus.channel('orders').emit('order.placed', { id: 'o1' }, { delivery: 'at-least-once' }),
    ).rejects.toThrow(/needs a `driver`/);
    bus.close();
  });
});

describe('retention', () => {
  it('drops an expired event loudly', async () => {
    const driver = memoryRecordDriver();
    const errors: string[] = [];
    const bus = createEventBus({
      consumer: 'account',
      driver,
      consumers: ['account'],
      invalidator: createInvalidator({ partition: 'p' }),
      onEventError: (message) => errors.push(message),
    });
    const orders = bus.channel('orders', { ttlMs: 0 });

    await orders.emit('order.placed', { id: 'o1' }, { delivery: 'at-least-once' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The next emit is what enforces the window.
    await orders.emit('order.placed', { id: 'o2' }, { delivery: 'at-least-once' });

    expect(errors.some((message) => message.includes('past its 0ms window'))).toBe(true);
    bus.close();
  });

  it('drops the oldest once the queue is full, loudly', async () => {
    const driver = memoryRecordDriver();
    const errors: string[] = [];
    const bus = createEventBus({
      consumer: 'account',
      driver,
      consumers: ['account'],
      invalidator: createInvalidator({ partition: 'p' }),
      onEventError: (message) => errors.push(message),
    });
    const orders = bus.channel('orders', { maxDepth: 2 });

    for (const id of ['o1', 'o2', 'o3']) {
      await orders.emit('order.placed', { id }, { delivery: 'at-least-once' });
    }

    // Unbounded fan-out retention is a storage quota that dies unattended; silent trimming is worse.
    expect(errors.some((message) => message.includes('at its 2 limit'))).toBe(true);
    bus.close();
  });
});

describe('intents', () => {
  const bus = () => createEventBus({ consumer: 'charts', invalidator: createInvalidator({ partition: 'p' }) });

  it('runs the highest-priority handler by default', async () => {
    const app = bus();
    const low = vi.fn(() => 'low');
    const high = vi.fn(() => 'high');

    app.addIntentListener('ViewOrder', { handler: low, priority: 1, label: 'legacy' });
    app.addIntentListener('ViewOrder', { handler: high, priority: 5, label: 'current' });

    const result = await app.raiseIntent('ViewOrder', { id: 'o1' });

    expect(result.handled).toHaveLength(1);
    expect(result.handled[0]!.candidate.label).toBe('current');
    expect(low).not.toHaveBeenCalled();
    app.close();
  });

  it('runs every handler under "all", in order', async () => {
    const app = bus();
    const order: string[] = [];
    app.addIntentListener('ViewOrder', { handler: () => void order.push('second'), priority: 1 });
    app.addIntentListener('ViewOrder', { handler: () => void order.push('first'), priority: 9 });

    await app.raiseIntent('ViewOrder', { id: 'o1' }, { resolve: 'all' });

    expect(order).toEqual(['first', 'second']);
    app.close();
  });

  it('asks the shell when told to', async () => {
    const app = bus();
    app.addIntentListener('ViewOrder', { handler: () => 'a', label: 'a' });
    app.addIntentListener('ViewOrder', { handler: () => 'b', label: 'b' });

    const result = await app.raiseIntent('ViewOrder', { id: 'o1' }, {
      resolve: 'ask',
      chooser: async (candidates) => candidates.find((candidate) => candidate.label === 'b')!,
    });

    expect(result.handled[0]!.result).toBe('b');
    app.close();
  });

  it('refuses "ask" with no chooser rather than picking for the user', async () => {
    const app = bus();
    app.addIntentListener('ViewOrder', { handler: () => 'a' });

    await expect(app.raiseIntent('ViewOrder', {}, { resolve: 'ask' })).rejects.toThrow(/needs a `chooser`/);
    app.close();
  });

  it('excludes a handler that cannot read the payload, before anyone is asked', async () => {
    const app = bus();
    // No way back from v2, so a v1 handler can never be handed this payload.
    const oneWay = versioned<OrderV1>('bus.one-way').next<OrderV2>('add currency, no inverse', (v1) => ({
      ...v1,
      currency: 'GBP',
    }));
    app.register('ViewOrder', oneWay);

    const stale = vi.fn();
    app.addIntentListener('ViewOrder', { handler: stale, as: 1, label: 'old build' });
    app.addIntentListener('ViewOrder', { handler: () => 'ok', label: 'current' });

    const result = await app.raiseIntent('ViewOrder', { id: 'o1', quantity: 1, currency: 'GBP' }, { resolve: 'ask', chooser: async (candidates) => candidates[0]! });

    // The user was never offered a handler that would have failed.
    expect(result.handled[0]!.candidate.label).toBe('current');
    expect(result.ineligible[0]!.reason).toContain('unreachable');
    expect(stale).not.toHaveBeenCalled();
    app.close();
  });

  it('projects the payload to the handler\'s version', async () => {
    const app = bus();
    app.register('ViewOrder', Order);
    const seen = vi.fn();
    app.addIntentListener('ViewOrder', { handler: seen, as: 1 });

    await app.raiseIntent('ViewOrder', { id: 'o1', quantity: 2, currency: 'GBP' });

    expect(seen).toHaveBeenCalledWith({ id: 'o1', quantity: 2 });
    app.close();
  });

  it('names what was excluded when nothing can handle it', async () => {
    const app = bus();
    const oneWay = versioned<OrderV1>('bus.one-way-2').next<OrderV2>('no inverse', (v1) => ({ ...v1, currency: 'GBP' }));
    app.register('ViewOrder', oneWay);
    app.addIntentListener('ViewOrder', { handler: vi.fn(), as: 1 });

    await expect(app.raiseIntent('ViewOrder', { id: 'o1', quantity: 1, currency: 'GBP' })).rejects.toThrow(
      NoIntentHandlerError,
    );
    app.close();
  });
});

describe('a context per entity', () => {
  const bus = (consumer = 'blotter', extra: Record<string, unknown> = {}) =>
    createEventBus({ consumer, invalidator: createInvalidator({ partition: 'p' }), ...extra });

  it('keeps two entities\' state apart under one channel name', () => {
    const app = bus();
    const one = app.channel<{ row: string }>('selection', { entity: 'fund:f1' });
    const two = app.channel<{ row: string }>('selection', { entity: 'fund:f2' });

    one.broadcast({ row: 'a' });
    two.broadcast({ row: 'b' });

    expect(one.state()).toEqual({ row: 'a' });
    expect(two.state()).toEqual({ row: 'b' });
    // And no conflict was raised: they are separate contexts, not two writers of one.
    expect(one.conflict()).toBeNull();
    app.close();
  });

  it('does not deliver one entity\'s broadcast to another\'s subscriber', () => {
    const app = bus();
    const seen = vi.fn();
    app.channel('selection', { entity: 'fund:f1' }).subscribe(seen);

    app.channel('selection', { entity: 'fund:f2' }).broadcast({ row: 'b' });

    expect(seen).not.toHaveBeenCalled();
    app.close();
  });

  it('registers the contract once for every entity', () => {
    const app = bus();
    app.register('holdings', Order); // the shape is per channel name, not per fund
    const behind = vi.fn();

    app.channel<OrderV2>('holdings', { entity: 'fund:f1' }).subscribe(behind as never, { as: 1 });
    app.channel<OrderV2>('holdings', { entity: 'fund:f1' }).broadcast({ id: 'o1', quantity: 3, currency: 'GBP' });

    // Every fund's holdings have the same shape, so the projection is keyed by the logical name.
    expect(behind).toHaveBeenCalledWith({ id: 'o1', quantity: 3 });
    app.close();
  });

  it('gives each entity its own transport when the channel is origin-scoped', async () => {
    const wire = wirePair();
    const one = bus('checkout', { broadcastChannel: wire });
    const two = bus('account', { broadcastChannel: wire });

    const sameFund = vi.fn();
    const otherFund = vi.fn();
    two.channel('orders', { scope: 'origin', entity: 'fund:f1' }).addEventListener('order.placed', sameFund);
    two.channel('orders', { scope: 'origin', entity: 'fund:f2' }).addEventListener('order.placed', otherFund);

    await one.channel('orders', { scope: 'origin', entity: 'fund:f1' }).emit('order.placed', { id: 'o1' });

    // Reach and instance are separate questions, and both are answered: it crossed the context
    // boundary, and it did not cross the entity boundary.
    expect(sameFund).toHaveBeenCalledOnce();
    expect(otherFund).not.toHaveBeenCalled();
    one.close();
    two.close();
  });

  it('addresses a durable event to one entity', async () => {
    const driver = memoryRecordDriver();
    const app = createEventBus({
      consumer: 'blotter',
      driver,
      consumers: ['blotter'],
      invalidator: createInvalidator({ partition: 'p' }),
    });

    const f1 = vi.fn();
    const f2 = vi.fn();
    app.channel('orders', { entity: 'fund:f1' }).addEventListener('order.placed', f1);
    app.channel('orders', { entity: 'fund:f2' }).addEventListener('order.placed', f2);

    await app
      .channel('orders', { entity: 'fund:f1' })
      .emit('order.placed', { id: 'o1' }, { delivery: 'at-least-once' });
    await app.flush();

    expect(f1).toHaveBeenCalledOnce();
    expect(f2).not.toHaveBeenCalled();
    app.close();
  });

  it('does not let a busy entity evict a quiet one from the queue', async () => {
    const driver = memoryRecordDriver();
    const errors: string[] = [];
    const app = createEventBus({
      consumer: 'blotter',
      driver,
      consumers: ['blotter'],
      invalidator: createInvalidator({ partition: 'p' }),
      onEventError: (message) => errors.push(message),
    });

    // One entry for the quiet fund, then enough for the busy one to hit its own limit.
    await app.channel('orders', { entity: 'fund:quiet', maxDepth: 2 }).emit('order.placed', { id: 'q1' }, { delivery: 'at-least-once' });
    for (const id of ['b1', 'b2', 'b3']) {
      await app.channel('orders', { entity: 'fund:busy', maxDepth: 2 }).emit('order.placed', { id }, { delivery: 'at-least-once' });
    }

    const quiet = vi.fn();
    app.channel('orders', { entity: 'fund:quiet' }).addEventListener('order.placed', quiet);
    await app.flush();

    // Retention is per channel instance: the busy fund trimmed only itself.
    expect(quiet).toHaveBeenCalledOnce();
    expect(errors.some((message) => message.includes('at its 2 limit'))).toBe(true);
    app.close();
  });
});

