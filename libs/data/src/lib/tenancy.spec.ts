import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryRecordDriver } from './memory-driver.js';
import { withLock } from './locks.js';
import { createRecordStore, type RecordDriver } from './record-store.js';
import { createTenancy, partitionKey, TenancyRecordSchema } from './tenancy.js';
import { versioned } from '@braidlabs/skew';

/**
 * Tenancy's job is not "which key do we use" — it is what sign-out destroys, and what happens when
 * destroying it is interrupted. The interesting tests are all in that second half.
 */

const NoteSchema = versioned<{ id: string; text: string }>('tenancy-spec-note');
const COLLECTIONS = ['entities', 'outbox'];

function setup(driver: RecordDriver = memoryRecordDriver()) {
  const tenancy = createTenancy({ driver, collections: COLLECTIONS });
  const notes = createRecordStore<{ id: string; text: string }>({
    driver,
    collection: 'entities',
    schema: NoteSchema,
  });
  return { driver, tenancy, notes };
}

describe('partitionKey', () => {
  it('separates the principal from the tenant being acted as', () => {
    expect(partitionKey('alice')).toBe(partitionKey('alice', 'alice'));
    expect(partitionKey('alice', 'acme')).not.toBe(partitionKey('alice', 'globex'));
    expect(partitionKey('alice', 'acme')).not.toBe(partitionKey('bob', 'acme'));
  });

  it('keeps the identifiers out of the key', () => {
    expect(partitionKey('alice@example.com', 'acme-holdings')).not.toContain('alice');
    expect(partitionKey('alice@example.com', 'acme-holdings')).not.toContain('acme');
  });
});

describe('activation', () => {
  it('refuses reads until someone signs in', () => {
    const { tenancy } = setup();
    expect(() => tenancy.partition()).toThrow(/sign in before reading/);
  });

  it('refuses reads again after sign-out', async () => {
    const { tenancy } = setup();
    await tenancy.signIn({ userId: 'alice' });
    await tenancy.signOut();

    expect(() => tenancy.partition()).toThrow(/sign in before reading/);
    expect(tenancy.current()).toBeNull();
  });

  it('leaves the previous tenant warm on disk when switching', async () => {
    const { tenancy, notes } = setup();
    await tenancy.signIn({ userId: 'alice', actingAs: 'acme' });
    const acme = tenancy.partition();
    await notes.put({ id: 'n1', partition: acme, value: { id: 'n1', text: 'acme note' } });

    const globex = await tenancy.switchTenant('globex');
    expect(globex).not.toBe(acme);
    // A switch is a pointer move: nothing was destroyed, so coming back does not re-fetch.
    expect((await notes.get('n1', acme))?.value.text).toBe('acme note');
    expect(await notes.get('n1', globex)).toBeNull();
  });

  it('cannot switch tenant before signing in', async () => {
    const { tenancy } = setup();
    await expect(tenancy.switchTenant('acme')).rejects.toThrow(/before signing in/);
  });
});

describe('purge on sign-out', () => {
  it('destroys every partition the user had, in every collection', async () => {
    const driver = memoryRecordDriver();
    const { tenancy, notes } = setup(driver);
    const outbox = createRecordStore<{ id: string; text: string }>({
      driver,
      collection: 'outbox',
      schema: NoteSchema,
    });

    await tenancy.signIn({ userId: 'alice', actingAs: 'acme' });
    const acme = tenancy.partition();
    await notes.put({ id: 'n1', partition: acme, value: { id: 'n1', text: 'acme' } });
    await outbox.put({ id: 'q1', partition: acme, value: { id: 'q1', text: 'queued' } });

    const globex = await tenancy.switchTenant('globex');
    await notes.put({ id: 'n2', partition: globex, value: { id: 'n2', text: 'globex' } });

    await tenancy.signOut();

    expect(await notes.list(acme)).toHaveLength(0);
    expect(await outbox.list(acme)).toHaveLength(0);
    expect(await notes.list(globex)).toHaveLength(0);
  });

  it('leaves another user\'s partitions alone', async () => {
    const driver = memoryRecordDriver();
    const { tenancy, notes } = setup(driver);

    await tenancy.signIn({ userId: 'bob' });
    const bob = tenancy.partition();
    await notes.put({ id: 'n1', partition: bob, value: { id: 'n1', text: "bob's" } });

    // A different user on the same device. Signing them out must not reach bob's records.
    const second = createTenancy({ driver, collections: COLLECTIONS });
    await second.signIn({ userId: 'alice' });
    await second.signOut();

    expect((await notes.get('n1', bob))?.value.text).toBe("bob's");
  });
});

describe('an interrupted purge', () => {
  /** A driver whose `clearPartition` fails from the given call onwards. */
  function flakyDriver(failFrom: number) {
    const driver = memoryRecordDriver();
    const real = driver.clearPartition.bind(driver);
    let calls = 0;
    let failing = true;
    driver.clearPartition = async (collection: string, partition: string) => {
      calls += 1;
      if (failing && calls >= failFrom) throw new Error('storage went away mid-purge');
      return real(collection, partition);
    };
    return { driver, repair: () => void (failing = false) };
  }

  it('keeps the marker until the purge finishes', async () => {
    const { driver } = flakyDriver(1);
    const { tenancy, notes } = setup(driver);
    const markers = createRecordStore({
      driver,
      collection: 'skew-tenancy',
      schema: TenancyRecordSchema,
    });

    await tenancy.signIn({ userId: 'alice' });
    await notes.put({ id: 'n1', partition: tenancy.partition(), value: { id: 'n1', text: 'x' } });
    await expect(tenancy.signOut()).rejects.toThrow();

    const left = await markers.list('meta');
    expect(left.some((record) => record.value.kind === 'purge')).toBe(true);
  });

  it('re-purges on the next open rather than serving what is left', async () => {
    const { driver, repair } = flakyDriver(1);
    const { tenancy, notes } = setup(driver);

    await tenancy.signIn({ userId: 'alice' });
    const partition = tenancy.partition();
    await notes.put({ id: 'n1', partition, value: { id: 'n1', text: 'secret' } });
    await expect(tenancy.signOut()).rejects.toThrow();

    repair();
    // A fresh instance over the same storage — a page reload after the failed sign-out.
    const reopened = createTenancy({ driver, collections: COLLECTIONS });
    await reopened.recover();

    expect(await notes.list(partition)).toHaveLength(0);
    await reopened.signIn({ userId: 'alice' });
    expect(reopened.partition()).toBe(partition);
  });

  it('ends the other tab\'s session when a sign-out destroys the partition it was reading', async () => {
    const driver = memoryRecordDriver();
    const { tenancy: tabA } = setup(driver);
    const tabB = createTenancy({ driver, collections: COLLECTIONS });

    await tabA.signIn({ userId: 'alice' });
    await tabB.signIn({ userId: 'alice' });
    await tabB.signOut();

    // Tab A holds a principal in memory and has no reason to doubt it until it looks.
    await tabA.recover();
    expect(tabA.current()).toBeNull();
    expect(() => tabA.partition()).toThrow(/sign in before reading/);
  });

  it("refuses a tenant switch in a tab whose session another tab's sign-out ended", async () => {
    const driver = memoryRecordDriver();
    const { tenancy: tabA, notes } = setup(driver);
    const tabB = createTenancy({ driver, collections: COLLECTIONS });

    await tabA.signIn({ userId: 'alice' });
    await tabB.signIn({ userId: 'alice' });
    await tabB.signOut();

    // Tab A has not looked yet. Its switch must not register a fresh partition for a signed-out person.
    await expect(tabA.switchTenant('acme')).rejects.toThrow(/session ended/);
    expect(tabA.current()).toBeNull();

    // Nothing was left behind for alice: a later sign-in and sign-out finds no orphaned partition.
    const tabC = createTenancy({ driver, collections: COLLECTIONS });
    await tabC.signIn({ userId: 'alice', actingAs: 'acme' });
    expect(await notes.list(tabC.partition())).toEqual([]);
  });

  it('refuses a partition it cannot confirm was cleared', async () => {
    const { driver } = flakyDriver(1);
    const { tenancy: tabA } = setup(driver);
    const tabB = createTenancy({ driver, collections: COLLECTIONS });

    await tabA.signIn({ userId: 'alice' });
    await tabB.signIn({ userId: 'alice' });
    await expect(tabB.signOut()).rejects.toThrow();

    // Tab A finds the marker, cannot finish the purge either, and must not fall back to serving
    // the half-emptied partition it still has a pointer to.
    await expect(tabA.recover()).rejects.toThrow();
    expect(() => tabA.partition()).toThrow(/half-purged/);
  });
});

describe('signIn during another tab\'s sign-out', () => {
  it('waits for the purge to finish before activating the partition', async () => {
    const { tenancy } = setup();
    let release!: () => void;
    const purging = new Promise<void>((resolve) => (release = resolve));
    // Another tab holds the purge lock for this user while it destroys their data.
    const held = withLock('skew:data:purge:alice', () => purging, { ifAvailable: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    let signedIn = false;
    const signingIn = tenancy.signIn({ userId: 'alice' }).then(() => void (signedIn = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signedIn).toBe(false);

    release();
    await held;
    await signingIn;
    expect(signedIn).toBe(true);
  });
});
