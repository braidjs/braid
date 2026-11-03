import { TestBed } from '@angular/core/testing';
import { createTenancy, memoryRecordDriver, type RecordDriver } from '@braidlabs/data';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_OPTIONS, OUTBOX_COLLECTION, resolveDataOptions } from './config';
import { OutboxService } from './outbox';

/**
 * The outbox must survive a reload, so the tests share one driver across TestBed instances: a fresh
 * TestBed over the same storage is exactly what a page refresh looks like.
 *
 * Sharing a driver between two *owners* is the other case these tests exist for — that is two apps
 * on one origin, which is where the queue used to lose work.
 */

function configure(options: {
  driver?: RecordDriver;
  owner?: string;
  maxAttempts?: number;
  onError?: (message: string, detail?: unknown) => void;
  partition?: () => string;
} = {}) {
  const driver = options.driver ?? memoryRecordDriver();

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: DATA_OPTIONS,
        useValue: resolveDataOptions({
          driver,
          owner: options.owner ?? 'billing',
          maxOutboxAttempts: options.maxAttempts ?? 5,
          ...(options.onError ? { onOutboxError: options.onError } : {}),
          ...(options.partition ? { partition: options.partition } : {}),
        }),
      },
    ],
  });

  return { outbox: TestBed.inject(OutboxService), driver };
}

beforeEach(() => TestBed.resetTestingModule());

describe('OutboxService', () => {
  it('queues work and reports it as pending', async () => {
    const { outbox } = configure();

    await outbox.enqueue({ mutationId: 'publish', input: { id: '1' }, schemaVersion: 1 });

    expect(outbox.pendingCount()).toBe(1);
    expect(outbox.hasPendingWork()).toBe(true);
  });

  it('flushes a queued entry through its registered runner', async () => {
    const { outbox } = configure();
    const runner = vi.fn(async () => undefined);
    outbox.register('publish', runner);

    await outbox.enqueue({ mutationId: 'publish', input: { id: '1' }, schemaVersion: 1 });
    const result = await outbox.flush();

    expect(runner).toHaveBeenCalledWith({ id: '1' }, expect.objectContaining({ attempts: 0 }));
    expect(result).toEqual({ sent: 1, failed: 0, remaining: 0, skipped: false });
    expect(outbox.pendingCount()).toBe(0);
  });

  it('survives a reload', async () => {
    const driver = memoryRecordDriver();

    // Session one: queue work, then the tab goes away.
    const first = configure({ driver });
    await first.outbox.enqueue({ mutationId: 'publish', input: { id: '7' }, schemaVersion: 3 });

    // Session two: same storage, fresh everything else.
    const second = configure({ driver });
    const runner = vi.fn(async () => undefined);
    second.outbox.register('publish', runner);
    await second.outbox.flush();

    expect(runner).toHaveBeenCalledWith({ id: '7' }, expect.objectContaining({ schemaVersion: 3 }));
  });

  it('flushes strictly in order', async () => {
    const { outbox } = configure();
    const order: string[] = [];
    outbox.register('op', async (input) => {
      order.push((input as { id: string }).id);
    });

    await outbox.enqueue({ mutationId: 'op', input: { id: 'a' }, schemaVersion: 1 });
    await outbox.enqueue({ mutationId: 'op', input: { id: 'b' }, schemaVersion: 1 });
    await outbox.enqueue({ mutationId: 'op', input: { id: 'c' }, schemaVersion: 1 });
    await outbox.flush();

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('stops the drain on failure rather than skipping ahead', async () => {
    // Entries commonly depend on each other; running later ones after an
    // earlier failure can apply them out of order.
    const { outbox } = configure();
    const seen: string[] = [];
    outbox.register('op', async (input) => {
      const id = (input as { id: string }).id;
      seen.push(id);
      if (id === 'a') throw new Error('network');
    });

    await outbox.enqueue({ mutationId: 'op', input: { id: 'a' }, schemaVersion: 1 });
    await outbox.enqueue({ mutationId: 'op', input: { id: 'b' }, schemaVersion: 1 });
    await outbox.flush();

    expect(seen).toEqual(['a']);
    expect(outbox.pendingCount()).toBe(2);
  });

  it('retries and records the attempt count', async () => {
    const { outbox } = configure({ maxAttempts: 5 });
    outbox.register('op', async () => {
      throw new Error('still down');
    });
    await outbox.enqueue({ mutationId: 'op', input: {}, schemaVersion: 1 });

    await outbox.flush();
    await outbox.flush();

    expect(outbox.entries()[0]?.attempts).toBe(2);
    expect(outbox.entries()[0]?.lastError).toBe('still down');
  });

  it('abandons an entry once attempts are exhausted, loudly', async () => {
    const onError = vi.fn();
    const { outbox } = configure({ maxAttempts: 2, onError });
    outbox.register('op', async () => {
      throw new Error('permanent');
    });
    await outbox.enqueue({ mutationId: 'op', input: {}, schemaVersion: 1 });

    await outbox.flush();
    await outbox.flush();

    expect(outbox.pendingCount()).toBe(0);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('giving up'), expect.anything());
  });

  it('keeps an entry whose mutation no longer exists in this build, and says so', async () => {
    // This used to drop the entry. It no longer does, and the change is deliberate: the mutation is
    // missing because the app did not re-register it at start-up, or renamed it between deploys —
    // and in both cases dropping discards a write the user was told had saved. A later build, or a
    // rollback, can still send it.
    const onError = vi.fn();
    const { outbox } = configure({ onError });
    await outbox.enqueue({ mutationId: 'renamed.away', input: {}, schemaVersion: 1 });

    const result = await outbox.flush();

    expect(result.failed).toBe(1);
    expect(outbox.pendingCount()).toBe(1);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('no registered mutation'),
      expect.anything(),
    );
  });

  it('lets an operator discard work nothing can replay', async () => {
    // Keeping the entry would be a leak if there were no way out — a queue that never drains and an
    // "unsent changes" badge that never clears. `clear()` is the deliberate way out.
    const { outbox } = configure({ onError: vi.fn() });
    await outbox.enqueue({ mutationId: 'renamed.away', input: {}, schemaVersion: 1 });
    await outbox.flush();

    await outbox.clear();

    expect(outbox.pendingCount()).toBe(0);
  });

  it('does not run two flushes concurrently', async () => {
    const { outbox } = configure();
    let active = 0;
    let maxActive = 0;
    outbox.register('op', async () => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    await outbox.enqueue({ mutationId: 'op', input: {}, schemaVersion: 1 });

    await Promise.all([outbox.flush(), outbox.flush()]);

    expect(maxActive).toBe(1);
  });

  it('clears the queue on demand', async () => {
    const { outbox } = configure();
    await outbox.enqueue({ mutationId: 'op', input: {}, schemaVersion: 1 });

    await outbox.clear();

    expect(outbox.pendingCount()).toBe(0);
  });

  it('works without persistence, keeping the queue in memory', async () => {
    const { outbox } = configure();
    const runner = vi.fn(async () => undefined);
    outbox.register('op', runner);

    await outbox.enqueue({ mutationId: 'op', input: {}, schemaVersion: 1 });
    await outbox.flush();

    expect(runner).toHaveBeenCalledOnce();
  });

  /**
   * Two apps on one origin, sharing storage. This is what used to lose work: the queue lived under
   * a single key, so the second app overwrote the first's and then dropped its entries for having
   * no registered runner.
   */
  describe('sharing an origin with another app', () => {
    it('does not overwrite the other app’s queue', async () => {
      const driver = memoryRecordDriver();
      const billing = configure({ driver, owner: 'billing' });
      await billing.outbox.enqueue({ mutationId: 'saveInvoice', input: {}, schemaVersion: 1 });

      const reviews = configure({ driver, owner: 'reviews' });
      await reviews.outbox.enqueue({ mutationId: 'postReview', input: {}, schemaVersion: 1 });

      expect(reviews.outbox.entries()).toHaveLength(1);
      expect(reviews.outbox.foreignEntries()).toHaveLength(1);
    });

    it('does not replay work it does not own', async () => {
      const driver = memoryRecordDriver();
      const billing = configure({ driver, owner: 'billing' });
      await billing.outbox.enqueue({ mutationId: 'saveInvoice', input: {}, schemaVersion: 1 });

      const reviews = configure({ driver, owner: 'reviews' });
      const runner = vi.fn(async () => undefined);
      reviews.outbox.register('saveInvoice', runner);
      await reviews.outbox.flush();

      expect(runner).not.toHaveBeenCalled();
    });

    it('does not drop work it does not own', async () => {
      // the old code found no runner for a foreign mutationId and discarded the entry
      const driver = memoryRecordDriver();
      const onError = vi.fn();
      const billing = configure({ driver, owner: 'billing' });
      await billing.outbox.enqueue({ mutationId: 'saveInvoice', input: {}, schemaVersion: 1 });

      const reviews = configure({ driver, owner: 'reviews', onError });
      await reviews.outbox.flush();

      expect(onError).not.toHaveBeenCalled();

      // and it is still there when its owner comes back
      const remounted = configure({ driver, owner: 'billing' });
      await remounted.outbox.load();
      expect(remounted.outbox.entries()).toHaveLength(1);
    });

    it('counts unsent work page-wide, not just its own', async () => {
      const driver = memoryRecordDriver();
      const billing = configure({ driver, owner: 'billing' });
      await billing.outbox.enqueue({ mutationId: 'a', input: {}, schemaVersion: 1 });

      const reviews = configure({ driver, owner: 'reviews' });
      await reviews.outbox.enqueue({ mutationId: 'b', input: {}, schemaVersion: 1 });

      expect(reviews.outbox.pendingCount()).toBe(2);
      expect(reviews.outbox.entries()).toHaveLength(1);
    });

    it('clears only its own work', async () => {
      const driver = memoryRecordDriver();
      const billing = configure({ driver, owner: 'billing' });
      await billing.outbox.enqueue({ mutationId: 'a', input: {}, schemaVersion: 1 });

      const reviews = configure({ driver, owner: 'reviews' });
      await reviews.outbox.enqueue({ mutationId: 'b', input: {}, schemaVersion: 1 });
      await reviews.outbox.clear();

      expect(reviews.outbox.entries()).toHaveLength(0);
      expect(reviews.outbox.foreignEntries()).toHaveLength(1);
    });
  });

  /**
   * The queue is stored per origin, so every open tab sees the same entries. Without exclusion each
   * one drains it on reconnect — replaying the same mutations against a server that is by
   * definition just coming back.
   */
  describe('flush leadership', () => {
    /** Two instances of the *same* app over one store: what two tabs look like. */
    function twoTabs() {
      const driver = memoryRecordDriver();
      const tabA = configure({ driver, owner: 'billing' });
      const tabB = configure({ driver, owner: 'billing' });
      return { driver, tabA: tabA.outbox, tabB: tabB.outbox };
    }

    it('replays a mutation once when two tabs flush together', async () => {
      const { tabA, tabB } = twoTabs();
      const runner = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      tabA.register('op', runner);
      tabB.register('op', runner);
      await tabA.enqueue({ mutationId: 'op', input: {}, schemaVersion: 1 });

      await Promise.all([tabA.flush(), tabB.flush()]);

      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('reports doing no work when it stands down', async () => {
      const { tabA, tabB } = twoTabs();
      tabA.register('op', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      tabB.register('op', async () => undefined);
      await tabA.enqueue({ mutationId: 'op', input: {}, schemaVersion: 1 });

      const [, standDown] = await Promise.all([tabA.flush(), tabB.flush()]);

      // `remaining` is whatever the store says at that moment — the other tab is still working, so
      // it is deliberately *not* rounded down to zero. Claiming the queue was drained by a flush
      // that did nothing would be the wrong kind of tidy.
      expect(standDown).toMatchObject({ sent: 0, failed: 0 });
    });

    it('leaves the queue drained once both tabs settle', async () => {
      const { tabA, tabB } = twoTabs();
      const runner = vi.fn(async () => undefined);
      tabA.register('op', runner);
      tabB.register('op', runner);
      await tabA.enqueue({ mutationId: 'op', input: {}, schemaVersion: 1 });

      await Promise.all([tabA.flush(), tabB.flush()]);
      await tabB.load();
      await tabB.flush();

      expect(runner).toHaveBeenCalledTimes(1);
      expect(tabB.pendingCount()).toBe(0);
    });

    it('lets a different app flush at the same time', async () => {
      // per-owner locks: two apps hold disjoint entries and have no reason to serialize
      const driver = memoryRecordDriver();
      const billing = configure({ driver, owner: 'billing' });
      const reviews = configure({ driver, owner: 'reviews' });

      const billingRunner = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      const reviewsRunner = vi.fn(async () => undefined);
      billing.outbox.register('a', billingRunner);
      reviews.outbox.register('b', reviewsRunner);

      await billing.outbox.enqueue({ mutationId: 'a', input: {}, schemaVersion: 1 });
      await reviews.outbox.enqueue({ mutationId: 'b', input: {}, schemaVersion: 1 });

      await Promise.all([billing.outbox.flush(), reviews.outbox.flush()]);

      expect(billingRunner).toHaveBeenCalledTimes(1);
      expect(reviewsRunner).toHaveBeenCalledTimes(1);
    });

    it('reports a stand-down as skipped, not as a flush that sent nothing', async () => {
      // `sent === 0` is also what a flush that ran and failed looks like; conflating them makes a
      // dead server look like a busy tab.
      const { tabA, tabB } = twoTabs();
      tabA.register('op', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      tabB.register('op', async () => undefined);
      await tabA.enqueue({ mutationId: 'op', input: {}, schemaVersion: 1 });

      const [ran, standDown] = await Promise.all([tabA.flush(), tabB.flush()]);

      expect(ran.skipped).toBe(false);
      expect(standDown.skipped).toBe(true);
    });

    it('does not report a failing flush as skipped', async () => {
      const { tabA } = twoTabs();
      tabA.register('op', async () => {
        throw new Error('server is down');
      });
      await tabA.enqueue({ mutationId: 'op', input: {}, schemaVersion: 1 });

      const result = await tabA.flush();

      expect(result).toMatchObject({ sent: 0, failed: 1, skipped: false });
    });

    it('frees the lock after a failing flush', async () => {
      const { tabA, tabB } = twoTabs();
      tabA.register('op', async () => {
        throw new Error('network');
      });
      const succeed = vi.fn(async () => undefined);
      tabB.register('op', succeed);
      await tabA.enqueue({ mutationId: 'op', input: {}, schemaVersion: 1 });

      await tabA.flush();
      await tabB.flush();

      // a lock a failed flush never released would wedge every later one
      expect(succeed).toHaveBeenCalledTimes(1);
    });
  });

  describe('owner', () => {
    it('refuses a persisted outbox with no owner, rather than colliding silently', () => {
      expect(() => resolveDataOptions({ persistOutbox: true })).toThrow(/needs `owner`/);
      expect(() => resolveDataOptions({ driver: memoryRecordDriver() })).toThrow(/needs `owner`/);
    });

    it('allows an in-memory outbox without one, since nothing is shared', () => {
      expect(() => resolveDataOptions({})).not.toThrow();
    });
  });
});

describe('OutboxService on a shared device', () => {
  it("does not flush one person's queued work under the next person's session", async () => {
    const driver = memoryRecordDriver();
    const tenancy = createTenancy({ driver, collections: [OUTBOX_COLLECTION] });
    const runner = vi.fn(async () => undefined);

    await tenancy.signIn({ userId: 'alice' });
    const first = configure({ driver, partition: () => tenancy.partition() });
    first.outbox.register('publish', runner);
    await first.outbox.enqueue({ mutationId: 'publish', input: { id: '1' }, schemaVersion: 1 });
    await tenancy.signOut();

    await tenancy.signIn({ userId: 'bob' });
    const next = configure({ driver, partition: () => tenancy.partition() });
    next.outbox.register('publish', runner);
    await next.outbox.flush();

    expect(runner).not.toHaveBeenCalled();
  });
});
