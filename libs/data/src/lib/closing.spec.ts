import { describe, expect, it, vi } from 'vitest';
import { memoryRecordDriver } from './memory-driver.js';
import { createOutbox } from './outbox.js';
import { flushOnClosing, trackDirty, type ClosingEnv } from './closing.js';

/** A stand-in for the `FragmentEnv` half core provides, with the handler exposed for the test. */
function closingEnv() {
  let handler: (() => Promise<{ flushed: number; dropped: number; deferred?: number }>) | undefined;
  const dirty: Array<string | null> = [];
  const env: ClosingEnv = {
    onClosing(next) {
      handler = next;
      return () => void (handler = undefined);
    },
    setDirty: (reason) => void dirty.push(reason),
  };
  return {
    env,
    dirty,
    close: () => handler?.() ?? Promise.reject(new Error('no closing handler registered')),
    get registered() {
      return handler !== undefined;
    },
  };
}

async function outboxWith(count: number) {
  const outbox = createOutbox({ driver: memoryRecordDriver(), owner: 'checkout' });
  for (let i = 0; i < count; i++) {
    await outbox.enqueue({ mutationId: 'placeOrder', input: { seq: i } });
  }
  return outbox;
}

describe('flushOnClosing()', () => {
  it('drains the queue when the fragment closes', async () => {
    const outbox = await outboxWith(50);
    const host = closingEnv();
    flushOnClosing(host.env, { outbox, owner: 'checkout', runnerFor: () => async () => undefined });

    const summary = await host.close();

    // The Phase 3 done-when case, now actually wired to something: 50 queued writes go out inside
    // the close window instead of waiting for a boot that may never come.
    expect(summary).toEqual({ flushed: 50, dropped: 0, deferred: 0 });
    expect(await outbox.mine()).toHaveLength(0);
  });

  it('reports unsent work as deferred, never as dropped', async () => {
    const outbox = await outboxWith(3);
    const host = closingEnv();
    flushOnClosing(host.env, {
      outbox,
      owner: 'checkout',
      runnerFor: () => async () => {
        throw new Error('the server is unreachable');
      },
      onError: () => undefined,
    });

    const summary = await host.close();

    // Nothing was lost — the entries are still in storage and replay on the next boot. Calling
    // that `dropped` would raise an alarm about data that is fine.
    expect(summary.dropped).toBe(0);
    expect(summary.deferred).toBe(3);
    expect(await outbox.mine()).toHaveLength(3);
  });

  it('keeps an entry whose mutation kind is not registered', async () => {
    const outbox = await outboxWith(2);
    const host = closingEnv();
    flushOnClosing(host.env, { outbox, owner: 'checkout', runnerFor: () => undefined, onError: () => undefined });

    const summary = await host.close();

    expect(summary).toMatchObject({ flushed: 0, dropped: 0, deferred: 2 });
  });

  it('unregisters', async () => {
    const outbox = await outboxWith(1);
    const host = closingEnv();
    const off = flushOnClosing(host.env, { outbox, owner: 'checkout', runnerFor: () => async () => undefined });

    off();
    expect(host.registered).toBe(false);
  });
});

describe('trackDirty()', () => {
  it('declares unsaved work while the queue is not empty', async () => {
    const host = closingEnv();
    await trackDirty(host.env, async () => 3);

    expect(host.dirty).toEqual(['3 unsent changes']);
  });

  it('says one change in the singular', async () => {
    const host = closingEnv();
    await trackDirty(host.env, async () => 1);

    expect(host.dirty).toEqual(['1 unsent change']);
  });

  it('clears the declaration on an empty queue', async () => {
    const host = closingEnv();
    await trackDirty(host.env, async () => 0);

    expect(host.dirty).toEqual([null]);
  });

  it('takes a caller’s wording', async () => {
    const host = closingEnv();
    await trackDirty(host.env, async () => 2, (pending) => `${pending} orders waiting to send`);

    expect(host.dirty).toEqual(['2 orders waiting to send']);
  });
});
