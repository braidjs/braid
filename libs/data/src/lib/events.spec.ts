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

  /** A document that started at `timeOrigin`, under `parent` (itself, for a top-level one). */
  function documentAt(timeOrigin: number, parent?: object): { parent: object; performance: { timeOrigin: number } } {
    const doc = { performance: { timeOrigin } } as { parent: object; performance: { timeOrigin: number } };
    doc.parent = parent ?? doc;
    return doc;
  }

  function busIn(context: object, wire: (name: string) => BroadcastChannelLike, consumer: string) {
    vi.stubGlobal('window', context);
    return createEventBus({ consumer, invalidator: createInvalidator({ partition: 'p' }), broadcastChannel: wire });
  }

  it('is the top document, so realms of one page share page scope and other tabs do not', () => {
    const wire = wirePair();
    const host = documentAt(1000.5);
    const realmA = busIn(documentAt(1001, host), wire, 'a');
    const realmB = busIn(documentAt(1002, host), wire, 'b');
    const otherTab = busIn(documentAt(1003, documentAt(2000.25)), wire, 'c');
    const inB = vi.fn();
    const inOtherTab = vi.fn();
    realmB.channel('selection').subscribe(inB);
    otherTab.channel('selection').subscribe(inOtherTab);

    realmA.channel('selection').broadcast({ id: 'row-1' });

    expect(inB).toHaveBeenCalledWith({ id: 'row-1' });
    expect(inOtherTab).not.toHaveBeenCalled();
    [realmA, realmB, otherTab].forEach((bus) => bus.close());
  });

  it('stops at the last same-origin document when the app is embedded in another site', () => {
    const wire = wirePair();
    const crossOriginTop = {
      get performance(): never {
        throw new DOMException('Blocked a frame from accessing a cross-origin frame', 'SecurityError');
      },
    };
    const host = documentAt(1000.5, crossOriginTop);
    const realmA = busIn(documentAt(1001, host), wire, 'a');
    const realmB = busIn(documentAt(1002, host), wire, 'b');
    const inB = vi.fn();
    realmB.channel('selection').subscribe(inB);

    realmA.channel('selection').broadcast({ id: 'row-1' });

    // the composed page is still one page, though its top cannot be read
    expect(inB).toHaveBeenCalledWith({ id: 'row-1' });
    realmA.close();
    realmB.close();
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
    stale.postMessage({ kind: 'state-reply', request: 'any', value: { userId: 'old' } });

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

describe('late join, without a storm or a false conflict', () => {
  /** A wire that counts what crosses it. */
  function countingWire() {
    const wire = wirePair();
    const sent: string[] = [];
    return {
      sent,
      wire: (name: string) => {
        const endpoint = wire(name);
        return { ...endpoint, postMessage: (message: unknown) => (sent.push((message as { kind: string }).kind), endpoint.postMessage(message)) };
      },
    };
  }
  const busOn = (consumer: string, wire: (name: string) => BroadcastChannelLike, extra: Partial<Parameters<typeof createEventBus>[0]> = {}) =>
    createEventBus({ consumer, invalidator: createInvalidator({ partition: 'p' }), broadcastChannel: wire, page: 'tab-1', ...extra });

  it('does not count adopting another context\'s state, then moving on from it, as a conflict', () => {
    const { wire } = countingWire();
    const one = busOn('checkout', wire);
    one.channel('selection').broadcast({ row: 1 });
    const two = busOn('account', wire);
    two.channel('selection').subscribe(vi.fn());

    // an ordinary next selection, not two writers racing
    two.channel('selection').broadcast({ row: 2 });

    expect(two.channel('selection').conflict()).toBeNull();
    expect(one.channel('selection').state()).toEqual({ row: 2 });
    one.close();
    two.close();
  });

  it('sends one reply to a late joiner, from the context that published, however many hold the state', () => {
    const { wire, sent } = countingWire();
    const publisher = busOn('a', wire);
    publisher.channel('selection').broadcast({ row: 1 });
    const holders = ['b', 'c', 'd', 'e'].map((consumer) => busOn(consumer, wire));
    holders.forEach((bus) => bus.channel('selection').subscribe(vi.fn()));
    sent.length = 0;

    const late = busOn('late', wire);
    const seen = vi.fn();
    late.channel('selection').subscribe(seen);

    expect(seen).toHaveBeenCalledWith({ row: 1 });
    expect(sent.filter((kind) => kind === 'state-reply')).toHaveLength(1);
    [publisher, ...holders, late].forEach((bus) => bus.close());
  });

  it('still answers when the publisher is gone, from whoever holds the state', async () => {
    const { wire, sent } = countingWire();
    const publisher = busOn('a', wire);
    publisher.channel('selection').broadcast({ row: 1 });
    const holders = ['b', 'c', 'd'].map((consumer) => busOn(consumer, wire));
    holders.forEach((bus) => bus.channel('selection').subscribe(vi.fn()));
    publisher.close();
    sent.length = 0;

    const late = busOn('late', wire);
    const seen = vi.fn();
    late.channel('selection').subscribe(seen);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(seen).toHaveBeenCalledWith({ row: 1 });
    // the first fallback answer cancels the others
    expect(sent.filter((kind) => kind === 'state-reply')).toHaveLength(1);
    [...holders, late].forEach((bus) => bus.close());
  });

  it('asks nothing for a channel used only for events', async () => {
    const { wire, sent } = countingWire();
    const bus = busOn('a', wire);

    bus.channel('orders').addEventListener('order.placed', vi.fn());
    await bus.channel('orders').emit('order.placed', { id: 'o1' });

    expect(sent).toEqual(['event']);
    bus.close();
  });

  it('does not bring back state that was cleared', () => {
    const { wire } = countingWire();
    const one = busOn('a', wire);
    const two = busOn('b', wire);
    two.channel('selection').subscribe(vi.fn());
    one.channel('selection').broadcast({ row: 1 });
    two.channel('selection').broadcast(undefined);

    // a reply to somebody else's request reaches every context
    wire('skew:events:default:page:tab-1:selection').postMessage({ kind: 'state-reply', request: 'someone-else', value: { row: 1 } });

    expect(two.channel('selection').state()).toBeUndefined();
    one.close();
    two.close();
  });

  it('reports a value that cannot be sent to other contexts, after delivering it here', async () => {
    const reported = vi.fn();
    const bus = busOn('a', (name) => ({ ...wirePair()(name), postMessage: () => { throw new DOMException('could not be cloned', 'DataCloneError'); } }), {
      onEventError: reported,
    });
    const seen = vi.fn();
    const handled = vi.fn();
    bus.channel('selection').subscribe(seen);
    bus.channel('selection').addEventListener('row.clicked', handled);

    expect(() => bus.channel('selection').broadcast({ row: 1 })).not.toThrow();
    await expect(bus.channel('selection').emit('row.clicked', { row: 1 })).resolves.toBeUndefined();

    expect(seen).toHaveBeenCalledWith({ row: 1 });
    expect(handled).toHaveBeenCalled();
    expect(reported).toHaveBeenCalled();
    bus.close();
  });

  it('registers nothing for a subscription whose signal already aborted', () => {
    const bus = createEventBus({ consumer: 'a', invalidator: createInvalidator({ partition: 'p' }) });
    bus.channel('selection').broadcast({ row: 1 });
    const seen = vi.fn();
    const controller = new AbortController();
    controller.abort();

    bus.channel('selection').subscribe(seen, { signal: controller.signal });
    bus.channel('selection').broadcast({ row: 2 });

    expect(seen).not.toHaveBeenCalled();
    bus.close();
  });
});

describe('state that persists across reloads', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const busWith = (driver: ReturnType<typeof memoryRecordDriver>, extra: Partial<Parameters<typeof createEventBus>[0]> = {}) =>
    createEventBus({ consumer: 'blotter', driver, invalidator: createInvalidator({ partition: 'p' }), ...extra });

  it('restores the last broadcast into a bus opened after a reload, with no other context alive', async () => {
    const driver = memoryRecordDriver();
    const before = busWith(driver);
    before.channel('selection', { persist: true }).broadcast({ id: 'row-7' });
    await tick();
    before.close();

    const after = busWith(driver);
    const seen = vi.fn();
    after.channel('selection', { persist: true }).subscribe(seen);
    await tick();

    expect(seen).toHaveBeenCalledWith({ id: 'row-7' });
    expect(after.channel('selection', { persist: true }).state()).toEqual({ id: 'row-7' });
    after.close();
  });

  it('forgets state that was cleared', async () => {
    const driver = memoryRecordDriver();
    const before = busWith(driver);
    const selection = before.channel('selection', { persist: true });
    selection.broadcast({ id: 'row-7' });
    selection.broadcast(undefined);
    await tick();
    before.close();

    const after = busWith(driver);
    const seen = vi.fn();
    after.channel('selection', { persist: true }).subscribe(seen);
    await tick();

    expect(seen).not.toHaveBeenCalled();
    after.close();
  });

  it('lets a value broadcast since the reload win over the stored one', async () => {
    const driver = memoryRecordDriver();
    const before = busWith(driver);
    before.channel('selection', { persist: true }).broadcast({ id: 'old' });
    await tick();
    before.close();

    const after = busWith(driver);
    const selection = after.channel('selection', { persist: true });
    // the user picks a row before storage answers
    selection.broadcast({ id: 'new' });
    await tick();

    expect(selection.state()).toEqual({ id: 'new' });
    after.close();
  });

  it('prefers a fresher value another context holds over the stored one', async () => {
    const driver = memoryRecordDriver();
    const wire = wirePair();
    const stale = busWith(driver, { page: 'tab-1', broadcastChannel: wire });
    stale.channel('selection', { persist: true }).broadcast({ id: 'stored' });
    await tick();
    stale.close();

    // another realm, without persistence, moved on since
    const other = createEventBus({ consumer: 'chart', invalidator: createInvalidator({ partition: 'p' }), page: 'tab-1', broadcastChannel: wire });
    await new Promise((resolve) => setTimeout(resolve, 5));
    other.channel('selection').broadcast({ id: 'fresh' });

    const reloaded = busWith(driver, { page: 'tab-1', broadcastChannel: wire });
    const selection = reloaded.channel('selection', { persist: true });
    selection.subscribe(vi.fn());
    await tick();

    expect(selection.state()).toEqual({ id: 'fresh' });
    other.close();
    reloaded.close();
  });

  it('stores under the contract, so a reader at an older version gets the older shape', async () => {
    const driver = memoryRecordDriver();
    const before = busWith(driver);
    before.register('orders', Order);
    before.channel('orders', { persist: true }).broadcast({ id: 'o1', quantity: 2, currency: 'EUR' });
    await tick();
    before.close();

    const after = busWith(driver);
    after.register('orders', Order);
    const behind = vi.fn();
    after.channel('orders', { persist: true }).subscribe(behind, { as: 1 });
    await tick();

    expect(behind).toHaveBeenCalledWith({ id: 'o1', quantity: 2 });
    after.close();
  });

  it('keeps one partition\'s state from another', async () => {
    const driver = memoryRecordDriver();
    const ana = busWith(driver, { partition: () => 'user:ana' });
    ana.channel('selection', { persist: true }).broadcast({ id: 'ana-row' });
    await tick();
    ana.close();

    const bo = busWith(driver, { partition: () => 'user:bo' });
    const seen = vi.fn();
    bo.channel('selection', { persist: true }).subscribe(seen);
    await tick();

    expect(seen).not.toHaveBeenCalled();
    bo.close();
  });

  it('refuses to persist without a driver rather than quietly forgetting', () => {
    const bus = createEventBus({ consumer: 'blotter', invalidator: createInvalidator({ partition: 'p' }) });

    expect(() => bus.channel('selection', { persist: true })).toThrow(/driver/);
    bus.close();
  });
});
