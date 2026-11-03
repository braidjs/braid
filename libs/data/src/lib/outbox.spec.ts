import { describe, expect, it, vi } from 'vitest';
import { drainOutbox } from './flush.js';
import { memoryRecordDriver } from './memory-driver.js';
import { createOutbox } from './outbox.js';
import { createTenancy } from './tenancy.js';

/** Two applications on one origin, sharing storage — the case that used to lose data. */
function twoApps() {
  const driver = memoryRecordDriver();
  return {
    driver,
    billing: createOutbox({ driver, owner: 'billing' }),
    reviews: createOutbox({ driver, owner: 'reviews' }),
  };
}

describe('outbox', () => {
  it('queues and returns an id', async () => {
    const { billing } = twoApps();

    const id = await billing.enqueue({ mutationId: 'saveInvoice', input: { total: 10 } });

    expect(id).toBeTruthy();
    expect(await billing.mine()).toHaveLength(1);
  });

  it('preserves queue order', async () => {
    const { billing } = twoApps();
    await billing.enqueue({ mutationId: 'first', input: 1 });
    await billing.enqueue({ mutationId: 'second', input: 2 });
    await billing.enqueue({ mutationId: 'third', input: 3 });

    expect((await billing.mine()).map((entry) => entry.mutationId)).toEqual(['first', 'second', 'third']);
  });

  describe('the data loss this replaces', () => {
    it('does not let a second app overwrite the first’s queue', async () => {
      // The old store put the whole queue under one key, so this scenario dropped `saveInvoice`.
      const { billing, reviews } = twoApps();

      await billing.enqueue({ mutationId: 'saveInvoice', input: { total: 10 } });
      await reviews.enqueue({ mutationId: 'postReview', input: { stars: 5 } });

      expect(await billing.mine()).toHaveLength(1);
      expect(await reviews.mine()).toHaveLength(1);
      expect(await billing.all()).toHaveLength(2);
    });

    it('does not offer another app’s entries for replay', async () => {
      // the old code found no runner for a foreign mutationId and dropped the entry
      const { billing, reviews } = twoApps();
      await billing.enqueue({ mutationId: 'saveInvoice', input: {} });

      expect(await reviews.mine()).toEqual([]);
    });

    it('leaves a foreign entry queued and identified, so it waits rather than vanishing', async () => {
      const { billing, reviews } = twoApps();
      await billing.enqueue({ mutationId: 'saveInvoice', input: {} });

      const waiting = await reviews.foreign();

      expect(waiting).toHaveLength(1);
      expect(waiting[0]).toMatchObject({ owner: 'billing', mutationId: 'saveInvoice' });
    });

    it('replays a waiting entry once its owner is back', async () => {
      // the fragment unmounted and remounted; its work survived
      const { driver, billing } = twoApps();
      await billing.enqueue({ mutationId: 'saveInvoice', input: { total: 10 } });

      const remounted = createOutbox({ driver, owner: 'billing' });

      expect((await remounted.mine())[0]).toMatchObject({ mutationId: 'saveInvoice' });
    });
  });

  describe('the page-wide view', () => {
    it('counts every app’s unsent work', async () => {
      const { billing, reviews } = twoApps();
      await billing.enqueue({ mutationId: 'a', input: 1 });
      await billing.enqueue({ mutationId: 'b', input: 2 });
      await reviews.enqueue({ mutationId: 'c', input: 3 });

      expect(await billing.all()).toHaveLength(3);
      expect(await reviews.all()).toHaveLength(3);
    });

    it('splits into mine and foreign without gaps', async () => {
      const { billing } = twoApps();
      const { reviews } = { reviews: createOutbox({ driver: memoryRecordDriver(), owner: 'reviews' }) };
      await billing.enqueue({ mutationId: 'a', input: 1 });
      void reviews;

      const [mine, foreign, all] = [await billing.mine(), await billing.foreign(), await billing.all()];
      expect(mine.length + foreign.length).toBe(all.length);
    });
  });

  describe('removal and retry', () => {
    it('removes a sent entry', async () => {
      const { billing } = twoApps();
      const id = await billing.enqueue({ mutationId: 'a', input: 1 });

      await billing.remove(id);

      expect(await billing.all()).toEqual([]);
    });

    it('counts attempts and keeps the entry queued', async () => {
      const { billing } = twoApps();
      const id = await billing.enqueue({ mutationId: 'a', input: 1 });

      expect(await billing.recordFailure(id, 'network down')).toBe(1);
      expect(await billing.recordFailure(id, 'network down')).toBe(2);

      const [entry] = await billing.mine();
      expect(entry).toMatchObject({ attempts: 2, lastError: 'network down' });
    });

    it('does not let a retry jump ahead of entries queued after it', async () => {
      const { billing } = twoApps();
      const first = await billing.enqueue({ mutationId: 'first', input: 1 });
      await billing.enqueue({ mutationId: 'second', input: 2 });

      await billing.recordFailure(first, 'nope');

      expect((await billing.mine()).map((entry) => entry.mutationId)).toEqual(['first', 'second']);
    });

    it('tolerates recording a failure on an entry a concurrent flush already sent', async () => {
      const { billing } = twoApps();
      const id = await billing.enqueue({ mutationId: 'a', input: 1 });
      await billing.remove(id);

      expect(await billing.recordFailure(id, 'too late')).toBe(0);
    });
  });

  it('survives a reload without reusing sequence numbers', async () => {
    const { driver, billing } = twoApps();
    await billing.enqueue({ mutationId: 'first', input: 1 });

    // a fresh instance over the same storage, as after a page reload
    const reloaded = createOutbox({ driver, owner: 'billing' });
    await reloaded.enqueue({ mutationId: 'second', input: 2 });

    const seqs = (await reloaded.mine()).map((entry) => entry.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(2);
  });
});

/**
 * One browser, two people. `owner` separates applications, not users, so a queue keyed only by
 * owner replays whatever the last person left under whoever signs in next.
 */
describe('outbox on a shared device', () => {
  function sharedDevice() {
    const driver = memoryRecordDriver();
    const tenancy = createTenancy({ driver, collections: ['outbox'] });
    const outbox = createOutbox({ driver, owner: 'orders', partition: () => tenancy.partition() });
    const sent = vi.fn(async () => undefined);
    const drain = () => drainOutbox({ outbox, owner: 'orders', runnerFor: () => sent });
    return { tenancy, outbox, sent, drain };
  }

  it("never replays one person's queued mutation under the next person's session", async () => {
    const { tenancy, outbox, sent, drain } = sharedDevice();

    await tenancy.signIn({ userId: 'alice' });
    await outbox.enqueue({ mutationId: 'order.place', input: { qty: 100 } });
    await tenancy.signOut();

    await tenancy.signIn({ userId: 'bob' });
    await drain();

    expect(sent).not.toHaveBeenCalled();
    expect(await outbox.mine()).toEqual([]);
  });

  it("purges a person's queue when they sign out", async () => {
    const { tenancy, outbox, sent, drain } = sharedDevice();

    await tenancy.signIn({ userId: 'alice' });
    await outbox.enqueue({ mutationId: 'order.place', input: { qty: 100 } });
    await tenancy.signOut();

    // Not held for later: what Alice queued on a shared device leaves with her.
    await tenancy.signIn({ userId: 'alice' });
    await drain();
    expect(sent).not.toHaveBeenCalled();
  });

  it("replays a person's queue for that person", async () => {
    const { tenancy, outbox, sent, drain } = sharedDevice();

    await tenancy.signIn({ userId: 'alice' });
    await outbox.enqueue({ mutationId: 'order.place', input: { qty: 1 } });
    await drain();

    expect(sent).toHaveBeenCalledWith({ qty: 1 }, expect.objectContaining({ mutationId: 'order.place' }));
  });

  it('keeps the constant default for a single-user device', async () => {
    const driver = memoryRecordDriver();
    const outbox = createOutbox({ driver, owner: 'orders' });
    await outbox.enqueue({ mutationId: 'order.place', input: {} });
    expect(await createOutbox({ driver, owner: 'orders' }).mine()).toHaveLength(1);
  });
});
