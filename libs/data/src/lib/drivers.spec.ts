import { IDBFactory, IDBKeyRange as FakeKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { indexedDbRecordDriver } from './indexeddb-driver.js';
import { memoryRecordDriver } from './memory-driver.js';
import type { RecordDriver, StoredRecord } from './record-store.js';

/**
 * The behavior every `RecordDriver` owes its callers, run against each driver that ships.
 *
 * One table rather than a copy per driver: the point of a driver contract is that the drivers agree,
 * and three hand-maintained copies of it are three chances for them not to.
 */

const drivers: [string, () => RecordDriver][] = [
  ['memory', () => memoryRecordDriver()],
  [
    'indexeddb',
    () =>
      indexedDbRecordDriver({
        collections: ['notes', 'other'],
        indexedDB: new IDBFactory() as unknown as IDBFactory,
        keyRange: FakeKeyRange as unknown as typeof IDBKeyRange,
      }),
  ],
];

const record = (partition: string, key: string, seq: number): StoredRecord => ({
  id: `${partition}\u0000${key}`,
  key,
  partition,
  seq,
  envelope: { schema: 'note', version: 1, data: { key } } as unknown as StoredRecord['envelope'],
});

describe.each(drivers)('%s driver', (_name, make) => {
  it('lists no partitions for an empty collection', async () => {
    expect(await make().partitions('notes')).toEqual([]);
  });

  it('lists each partition once, sorted', async () => {
    const driver = make();
    await driver.put('notes', record('tenant-b', 'n1', 1));
    await driver.put('notes', record('tenant-a', 'n2', 2));
    await driver.put('notes', record('tenant-b', 'n3', 3));
    await driver.put('other', record('tenant-c', 'n4', 4));

    expect(await driver.partitions('notes')).toEqual(['tenant-a', 'tenant-b']);
  });

  it('drops a partition once it is cleared', async () => {
    const driver = make();
    await driver.put('notes', record('tenant-a', 'n1', 1));
    await driver.put('notes', record('tenant-b', 'n2', 2));
    await driver.clearPartition('notes', 'tenant-a');

    expect(await driver.partitions('notes')).toEqual(['tenant-b']);
  });

  it('round-trips, lists in seq order within a partition, and deletes', async () => {
    const driver = make();
    await driver.put('notes', record('tenant-a', 'late', 5));
    await driver.put('notes', record('tenant-a', 'early', 2));
    await driver.put('notes', record('tenant-0', 'elsewhere', 1));

    expect((await driver.get('notes', 'tenant-a\u0000late'))?.seq).toBe(5);
    expect((await driver.list('notes', 'tenant-a')).map((r) => r.key)).toEqual(['early', 'late']);
    expect(await driver.highestSeq('notes')).toBe(5);

    await driver.delete('notes', 'tenant-a\u0000late');
    expect(await driver.get('notes', 'tenant-a\u0000late')).toBeNull();
  });

  it('does not let a caller mutate a stored record through the object it passed', async () => {
    const driver = make();
    const input = record('tenant-a', 'n1', 1);
    await driver.put('notes', input);
    input.seq = 99;

    expect((await driver.get('notes', 'tenant-a\u0000n1'))?.seq).toBe(1);
  });
});
