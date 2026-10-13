import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSchema, resetSchemaRegistry, versioned } from '@braidlabs/skew';
import { memoryRecordDriver } from './memory-driver.js';
import { createRecordStore } from './record-store.js';

interface ClientV1 {
  id: string;
  name: string;
}
interface ClientV2 extends ClientV1 {
  household: string;
}

/** v1 → v2 adds a household the older shape cannot carry. */
const ClientV1Schema = versioned<ClientV1>('client');
const ClientV2Schema = versioned<ClientV1>('client').next<ClientV2>('introduce household', {
  up: (v1) => ({ ...v1, household: 'unknown' }),
  down: ({ household: _household, ...rest }) => rest,
  derives: ['household'],
  lossy: ['household'],
});

const store = <T>(schema: Parameters<typeof createRecordStore<T>>[0]['schema'], driver = memoryRecordDriver()) =>
  createRecordStore<T>({ driver, collection: 'clients', schema });

afterEach(() => resetSchemaRegistry());

describe('record store', () => {
  it('round-trips a record', async () => {
    const clients = store<ClientV1>(ClientV1Schema);
    await clients.put({ id: 'c1', partition: 'tenant-a', value: { id: 'c1', name: 'Ada' } });

    expect((await clients.get('c1', 'tenant-a'))?.value).toEqual({ id: 'c1', name: 'Ada' });
  });

  it('returns null for a record that is not there', async () => {
    expect(await store<ClientV1>(ClientV1Schema).get('nope', 'tenant-a')).toBeNull();
  });

  it('lists a partition in sequence order', async () => {
    const clients = store<ClientV1>(ClientV1Schema);
    await clients.put({ id: 'b', partition: 'tenant-a', value: { id: 'b', name: 'B' } });
    await clients.put({ id: 'a', partition: 'tenant-a', value: { id: 'a', name: 'A' } });

    expect((await clients.list('tenant-a')).map((record) => record.id)).toEqual(['b', 'a']);
  });

  describe('partitions', () => {
    it('never leaks across a tenant boundary', async () => {
      const clients = store<ClientV1>(ClientV1Schema);
      await clients.put({ id: 'c1', partition: 'tenant-a', value: { id: 'c1', name: 'Ada' } });
      await clients.put({ id: 'c2', partition: 'tenant-b', value: { id: 'c2', name: 'Grace' } });

      expect((await clients.list('tenant-a')).map((r) => r.id)).toEqual(['c1']);
      expect((await clients.list('tenant-b')).map((r) => r.id)).toEqual(['c2']);
    });

    it('purges one partition without touching another', async () => {
      // this is sign-out; it has to be complete for its partition and inert for every other
      const clients = store<ClientV1>(ClientV1Schema);
      await clients.put({ id: 'c1', partition: 'tenant-a', value: { id: 'c1', name: 'Ada' } });
      await clients.put({ id: 'c2', partition: 'tenant-b', value: { id: 'c2', name: 'Grace' } });

      await clients.clearPartition('tenant-a');

      expect(await clients.list('tenant-a')).toEqual([]);
      expect(await clients.list('tenant-b')).toHaveLength(1);
    });

    it('does not let one tenant overwrite another’s record of the same id', async () => {
      // Found by a query test: records were keyed by id alone, so `put` crossed the boundary and
      // `get` read across it. `list` filtered correctly, which is why it went unnoticed.
      const clients = store<ClientV1>(ClientV1Schema);
      await clients.put({ id: 'c1', partition: 'tenant-a', value: { id: 'c1', name: 'Ada' } });
      await clients.put({ id: 'c1', partition: 'tenant-b', value: { id: 'c1', name: 'Grace' } });

      expect((await clients.get('c1', 'tenant-a'))?.value.name).toBe('Ada');
      expect((await clients.get('c1', 'tenant-b'))?.value.name).toBe('Grace');
    });

    it('does not read another tenant’s record', async () => {
      const clients = store<ClientV1>(ClientV1Schema);
      await clients.put({ id: 'c1', partition: 'tenant-a', value: { id: 'c1', name: 'Ada' } });

      expect(await clients.get('c1', 'tenant-b')).toBeNull();
    });

    it('does not delete across a tenant boundary', async () => {
      const clients = store<ClientV1>(ClientV1Schema);
      await clients.put({ id: 'c1', partition: 'tenant-a', value: { id: 'c1', name: 'Ada' } });

      await clients.delete('c1', 'tenant-b');

      expect(await clients.get('c1', 'tenant-a')).not.toBeNull();
    });

    it('is safe to purge twice, so an interrupted purge can be re-run', async () => {
      const clients = store<ClientV1>(ClientV1Schema);
      await clients.put({ id: 'c1', partition: 'tenant-a', value: { id: 'c1', name: 'Ada' } });

      await clients.clearPartition('tenant-a');
      await expect(clients.clearPartition('tenant-a')).resolves.toBeUndefined();
    });
  });

  describe('skew — the reason records are enveloped', () => {
    it('migrates a record written by an older build up to this reader', async () => {
      const driver = memoryRecordDriver();
      // written months ago by a build that only knew v1
      await store<ClientV1>(ClientV1Schema, driver).put({
        id: 'c1',
        partition: 'tenant-a',
        value: { id: 'c1', name: 'Ada' },
      });

      const modern = store<ClientV2>(ClientV2Schema, driver);
      const record = await modern.get('c1', 'tenant-a');

      expect(record?.value).toEqual({ id: 'c1', name: 'Ada', household: 'unknown' });
      expect(record?.migratedFrom).toBe(1);
    });

    it('tells the reader which fields were guessed rather than reported', async () => {
      const driver = memoryRecordDriver();
      await store<ClientV1>(ClientV1Schema, driver).put({
        id: 'c1',
        partition: 'tenant-a',
        value: { id: 'c1', name: 'Ada' },
      });

      const record = await store<ClientV2>(ClientV2Schema, driver).get('c1', 'tenant-a');

      // a component that cannot tell a guess from a fact is trusting a guess
      expect(record?.derivedPaths).toContain('household');
    });

    it('projects a newer record down for an older reader, and says what was lost', async () => {
      // The down-step lives in the *newer* chain, so the older reader can only use it if that
      // chain is reachable — which is what the shared registry is for.
      registerSchema(ClientV2Schema);

      const driver = memoryRecordDriver();
      await store<ClientV2>(ClientV2Schema, driver).put({
        id: 'c1',
        partition: 'tenant-a',
        value: { id: 'c1', name: 'Ada', household: 'Lovelace' },
      });

      const legacy = await store<ClientV1>(ClientV1Schema, driver).get('c1', 'tenant-a');

      expect(legacy?.value).toEqual({ id: 'c1', name: 'Ada' });
      expect(legacy?.downgradedFrom).toBe(2);
      expect(legacy?.lossyPaths).toContain('household');
    });

    it('refuses a newer record when the down-step is not reachable', async () => {
      // The constraint that matters for Braid: realms are separate JavaScript contexts, so the
      // shared registry is *per realm*. A fragment two versions behind, in its own realm, cannot
      // borrow the newer chain from the fragment that wrote the record — it must ship the
      // down-steps itself or accept `ahead` and refetch. Failing loudly is the correct outcome;
      // silently handing over a v2 payload typed as v1 would not be.
      const driver = memoryRecordDriver();
      await store<ClientV2>(ClientV2Schema, driver).put({
        id: 'c1',
        partition: 'tenant-a',
        value: { id: 'c1', name: 'Ada', household: 'Lovelace' },
      });

      const failures = await store<ClientV1>(ClientV1Schema, driver).unreadable('tenant-a');

      expect(failures[0]?.failure.reason).toBe('ahead');
      expect(await store<ClientV1>(ClientV1Schema, driver).get('c1', 'tenant-a')).toBeNull();
    });

    it('reports an unreadable record rather than throwing mid-list', async () => {
      const driver = memoryRecordDriver();
      const onReadFailure = vi.fn();
      await driver.put('clients', {
        id: 'tenant-a\u0000broken',
        key: 'broken',
        partition: 'tenant-a',
        seq: 1,
        envelope: { v: 99, payload: { nope: true }, n: 'client' },
      });

      const clients = createRecordStore<ClientV1>({
        driver,
        collection: 'clients',
        schema: ClientV1Schema,
        onReadFailure,
      });

      expect(await clients.list('tenant-a')).toEqual([]);
      expect(onReadFailure).toHaveBeenCalledWith('broken', expect.objectContaining({ ok: false }));
    });

    it('surfaces unreadable records separately, so a failure is not merely absent', async () => {
      const driver = memoryRecordDriver();
      await driver.put('clients', {
        id: 'tenant-a\u0000broken',
        key: 'broken',
        partition: 'tenant-a',
        seq: 1,
        envelope: { v: 99, payload: {}, n: 'client' },
      });

      const failures = await store<ClientV1>(ClientV1Schema, driver).unreadable('tenant-a');

      expect(failures).toHaveLength(1);
      expect(failures[0]?.id).toBe('broken');
      expect(failures[0]?.failure.reason).toBe('ahead');
    });
  });

  describe('sequencing', () => {
    it('allocates increasing sequence numbers', async () => {
      const clients = store<ClientV1>(ClientV1Schema);
      const first = await clients.put({ id: 'a', partition: 'p', value: { id: 'a', name: 'A' } });
      const second = await clients.put({ id: 'b', partition: 'p', value: { id: 'b', name: 'B' } });

      expect(second).toBeGreaterThan(first);
    });

    it('continues past what is already stored, so a reload cannot reuse a number', async () => {
      const driver = memoryRecordDriver();
      await store<ClientV1>(ClientV1Schema, driver).put({ id: 'a', partition: 'p', value: { id: 'a', name: 'A' } });

      const reloaded = store<ClientV1>(ClientV1Schema, driver);
      const seq = await reloaded.put({ id: 'b', partition: 'p', value: { id: 'b', name: 'B' } });

      expect(seq).toBeGreaterThan(1);
    });

    it('gives every concurrent writer a distinct number', async () => {
      // Real IndexedDB caught this and the in-memory driver did not: awaiting between reading the
      // counter and advancing it let fifty parallel appends all observe the same value.
      const clients = store<ClientV1>(ClientV1Schema);

      const seqs = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          clients.put({ id: `c${i}`, partition: 'p', value: { id: `c${i}`, name: `${i}` } }),
        ),
      );

      expect(new Set(seqs).size).toBe(50);
    });

    it('keeps an explicit sequence when one is given', async () => {
      const clients = store<ClientV1>(ClientV1Schema);
      await clients.put({ id: 'a', partition: 'p', value: { id: 'a', name: 'A' }, seq: 42 });

      expect((await clients.get('a', 'p'))?.seq).toBe(42);
    });
  });

  it('does not let a caller mutate a stored record through the object it passed', async () => {
    const clients = store<ClientV1>(ClientV1Schema);
    const value = { id: 'c1', name: 'Ada' };
    await clients.put({ id: 'c1', partition: 'p', value });

    value.name = 'mutated';

    expect((await clients.get('c1', 'p'))?.value.name).toBe('Ada');
  });
});

describe('partitions and writes', () => {
  it('lists the partitions holding records, including ones this reader cannot read', async () => {
    const driver = memoryRecordDriver();
    await store<ClientV2>(ClientV2Schema, driver).put({
      id: 'c1',
      partition: 'tenant-b',
      value: { id: 'c1', name: 'Ada', household: 'h' },
    });
    const older = store<ClientV1>(versioned<ClientV1>('client'), driver);
    await older.put({ id: 'c2', partition: 'tenant-a', value: { id: 'c2', name: 'Grace' } });

    expect(await older.list('tenant-b')).toEqual([]);
    expect(await older.partitions()).toEqual(['tenant-a', 'tenant-b']);
  });

  it('reports each landed put and delete with the caller key', async () => {
    const onWrite = vi.fn();
    const clients = createRecordStore<ClientV1>({
      driver: memoryRecordDriver(),
      collection: 'clients',
      schema: ClientV1Schema,
      onWrite,
    });

    await clients.put({ id: 'c1', partition: 'p', value: { id: 'c1', name: 'Ada' } });
    await clients.delete('c1', 'p');

    expect(onWrite.mock.calls).toEqual([
      [{ type: 'put', partition: 'p', key: 'c1' }],
      [{ type: 'delete', partition: 'p', key: 'c1' }],
    ]);
  });

  it('reports nothing for a write the driver rejected', async () => {
    const onWrite = vi.fn();
    const driver = memoryRecordDriver();
    driver.put = () => Promise.reject(new Error('quota'));
    const clients = createRecordStore<ClientV1>({ driver, collection: 'clients', schema: ClientV1Schema, onWrite });

    await expect(clients.put({ id: 'c1', partition: 'p', value: { id: 'c1', name: 'Ada' } })).rejects.toThrow('quota');
    expect(onWrite).not.toHaveBeenCalled();
  });
});
