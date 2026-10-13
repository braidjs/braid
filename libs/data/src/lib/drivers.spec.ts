import { IDBFactory, IDBKeyRange as FakeKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { versioned } from '@braidlabs/skew';
import { indexedDbRecordDriver } from './indexeddb-driver.js';
import { memoryRecordDriver } from './memory-driver.js';
import { createRecordStore, type RecordDriver, type StoredRecord } from './record-store.js';
import { sessionStorageRecordDriver } from './session-storage-driver.js';

/**
 * The behavior every `RecordDriver` owes its callers, run against each driver that ships.
 *
 * One table rather than a copy per driver: the point of a driver contract is that the drivers agree,
 * and three hand-maintained copies of it are three chances for them not to.
 */

/** A `Storage` over a Map, so the tests need no DOM. `setItem` can be made to fail. */
function fakeStorage(setItem?: (key: string, value: string) => void): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      setItem?.(key, value);
      items.set(key, String(value));
    },
    removeItem: (key) => void items.delete(key),
    clear: () => items.clear(),
  };
}

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
  ['sessionStorage', () => sessionStorageRecordDriver({ storage: fakeStorage() })],
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

  it('starts empty: no highest seq, no record', async () => {
    const driver = make();
    expect(await driver.highestSeq('notes')).toBe(0);
    expect(await driver.get('notes', 'tenant-a\u0000missing')).toBeNull();
  });

  it('clears a partition in one collection only', async () => {
    const driver = make();
    await driver.put('notes', record('tenant-a', 'n1', 1));
    await driver.put('other', record('tenant-a', 'n2', 2));
    await driver.clearPartition('notes', 'tenant-a');

    expect(await driver.partitions('other')).toEqual(['tenant-a']);
  });

  it('does not let a caller mutate a stored record through the object it passed', async () => {
    const driver = make();
    const input = record('tenant-a', 'n1', 1);
    await driver.put('notes', input);
    input.seq = 99;

    expect((await driver.get('notes', 'tenant-a\u0000n1'))?.seq).toBe(1);
  });
});

/** What only the session driver has to get right: storage that is missing, broken or full. */
const Note = versioned<{ title: string }>('session-spec-note');

describe('session storage driver', () => {
  it('keeps records across a reload of the driver', async () => {
    const storage = fakeStorage();
    const before = createRecordStore({ driver: sessionStorageRecordDriver({ storage }), collection: 'notes', schema: Note });
    await before.put({ id: 'n1', partition: 'p', value: { title: 'kept' } });

    const after = createRecordStore({ driver: sessionStorageRecordDriver({ storage }), collection: 'notes', schema: Note });

    expect((await after.get('n1', 'p'))?.value).toEqual({ title: 'kept' });
    expect(await after.put({ id: 'n2', partition: 'p', value: { title: 'next' } })).toBe(2);
  });

  it('leaves keys it does not own alone', async () => {
    const storage = fakeStorage();
    storage.setItem('someone-else', 'theirs');
    const driver = sessionStorageRecordDriver({ storage });
    await createRecordStore({ driver, collection: 'notes', schema: Note }).put({ id: 'n1', partition: 'p', value: { title: 'x' } });

    await driver.clearPartition('notes', 'p');

    expect(storage.getItem('someone-else')).toBe('theirs');
    expect(await driver.partitions('notes')).toEqual([]);
  });

  it('can be constructed where there is no sessionStorage, and says so on first use', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        // A sandboxed iframe throws on the lookup itself.
        throw new DOMException('denied', 'SecurityError');
      },
    });

    try {
      const driver = sessionStorageRecordDriver();
      await expect(driver.list('notes', 'p')).rejects.toThrow(/sessionStorage is not usable/);
    } finally {
      if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
      else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
    }
  });

  it('rejects when the storage is present but every write fails', async () => {
    const driver = sessionStorageRecordDriver({
      storage: fakeStorage(() => {
        throw new DOMException('private mode', 'QuotaExceededError');
      }),
    });

    await expect(driver.highestSeq('notes')).rejects.toThrow(/sessionStorage is not usable/);
  });

  it('propagates a quota error from a write rather than swallowing it', async () => {
    let full = false;
    const driver = sessionStorageRecordDriver({
      storage: fakeStorage(() => {
        if (full) throw new DOMException('full', 'QuotaExceededError');
      }),
    });
    const notes = createRecordStore({ driver, collection: 'notes', schema: Note });
    await notes.put({ id: 'n1', partition: 'p', value: { title: 'fits' } });
    full = true;

    await expect(notes.put({ id: 'n2', partition: 'p', value: { title: 'does not' } })).rejects.toThrow('full');
  });

  it('skips items under its prefix that are not records, and can still purge', async () => {
    const storage = fakeStorage();
    const driver = sessionStorageRecordDriver({ storage });
    await driver.put('notes', record('tenant-a', 'good', 3));
    storage.setItem('skew:data:notes\u0000tenant-a\u0000junk', 'not json');
    storage.setItem('skew:data:notes\u0000tenant-a\u0000null', 'null');
    storage.setItem('skew:data:notes\u0000tenant-a\u0000str', '"str"');

    expect((await driver.list('notes', 'tenant-a')).map((r) => r.key)).toEqual(['good']);
    expect(await driver.partitions('notes')).toEqual(['tenant-a']);
    expect(await driver.highestSeq('notes')).toBe(3);

    await driver.clearPartition('notes', 'tenant-a');
    expect([...Array(storage.length).keys()].map((i) => storage.key(i))).toEqual([]);
  });

  it('purges only the partition named, not one it is a prefix of', async () => {
    const driver = sessionStorageRecordDriver({ storage: fakeStorage() });
    await driver.put('notes', record('p', 'n1', 1));
    await driver.put('notes', record('p2', 'n2', 2));

    await driver.clearPartition('notes', 'p');

    expect(await driver.partitions('notes')).toEqual(['p2']);
  });

  it('refuses a collection name that would collide with another collection', async () => {
    const driver = sessionStorageRecordDriver({ storage: fakeStorage() });
    await expect(driver.put('a\u0000b', record('p', 'k', 1))).rejects.toThrow(/cannot contain U\+0000/);
  });
});
