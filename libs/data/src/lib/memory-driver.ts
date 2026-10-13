import type { RecordDriver, StoredRecord } from './record-store.js';

/**
 * An in-memory driver.
 *
 * The reference implementation and the one tests run against — every behavior the IndexedDB driver
 * must exhibit is pinned here first, where it is observable without a browser.
 *
 * Not durable, so never the primary store for anything the user would mind losing.
 */
export function memoryRecordDriver(): RecordDriver {
  const collections = new Map<string, Map<string, StoredRecord>>();

  const of = (collection: string): Map<string, StoredRecord> => {
    let records = collections.get(collection);
    if (!records) {
      records = new Map();
      collections.set(collection, records);
    }
    return records;
  };

  return {
    async put(collection, record) {
      // Structured-cloned on the way in so a caller mutating the object it passed cannot reach
      // back into the store — the same rule the real driver gets for free from IndexedDB.
      of(collection).set(record.id, structuredClone(record));
    },

    async get(collection, id) {
      const record = of(collection).get(id);
      return record ? structuredClone(record) : null;
    },

    async delete(collection, id) {
      of(collection).delete(id);
    },

    async list(collection, partition) {
      return [...of(collection).values()]
        .filter((record) => record.partition === partition)
        .sort((a, b) => a.seq - b.seq)
        .map((record) => structuredClone(record));
    },

    async clearPartition(collection, partition) {
      const records = of(collection);
      for (const [id, record] of records) {
        if (record.partition === partition) records.delete(id);
      }
    },

    async partitions(collection) {
      return [...new Set([...of(collection).values()].map((record) => record.partition))].sort();
    },

    async highestSeq(collection) {
      let highest = 0;
      for (const record of of(collection).values()) highest = Math.max(highest, record.seq);
      return highest;
    },
  };
}
