import type { RecordDriver, StoredRecord } from './record-store.js';

export interface SessionStorageDriverOptions {
  /** Injectable for tests. Defaults to `globalThis.sessionStorage`, looked up on first use. */
  storage?: Storage;
}

const PREFIX = 'braid:data:';

/**
 * `sessionStorage`, for records that should outlive a reload but not the tab.
 *
 * The cases are narrower than they look: a checkout in progress, a wizard's draft, a guest's cart
 * that should not follow them to the next tab. Anything the user would mind losing when the tab
 * closes belongs in IndexedDB instead.
 *
 * Every record is its own storage item, keyed by collection and storage id, so a write is one
 * `setItem` and there is still no read-modify-write anywhere. `sessionStorage` is synchronous and
 * private to the tab, which makes each of those single operations atomic without any locking.
 *
 * Reads that span records — `list`, `partitions`, `highestSeq` — scan the tab's keys. That is O(n)
 * in everything stored, which session-sized data keeps small.
 *
 * Two deliberate differences from the `webStorageDriver` in `@braidlabs/skew`, which is a cache:
 *
 * - **No silent fallback to memory.** That driver can afford one because losing a cache entry costs a
 *   refetch. This one may hold the outbox, and a store that quietly stopped persisting is a write the
 *   user was told had saved. Unusable storage rejects on first use with an error that says so, as
 *   the IndexedDB driver does — choose `memoryRecordDriver` explicitly if that is acceptable.
 * - **Quota errors propagate.** For the same reason.
 *
 * Values are stored as JSON rather than structured clones, so a `Date` comes back as a string. The
 * envelopes this stores are JSON-safe by construction, which is also what the rest of the library
 * assumes when it compares them.
 */
export function sessionStorageRecordDriver(options: SessionStorageDriverOptions = {}): RecordDriver {
  let resolved: Storage | null = null;

  /**
   * Resolved lazily so constructing the driver never throws — on the server, or in a sandboxed
   * iframe where merely *reading* `globalThis.sessionStorage` raises a `SecurityError`.
   */
  function storage(): Storage {
    if (resolved) return resolved;

    let candidate: Storage | undefined;
    try {
      candidate = options.storage ?? globalThis.sessionStorage;
      // Present is not the same as usable: Safari's private mode used to expose a storage whose
      // every write threw. Probing once up front turns that into one clear error here rather than
      // an obscure one on the first real write.
      candidate.setItem(`${PREFIX}probe`, '1');
      candidate.removeItem(`${PREFIX}probe`);
    } catch (error) {
      throw new Error(
        'skew-data: sessionStorage is not usable in this environment, so the session driver cannot ' +
          `store anything (${error instanceof Error ? error.message : String(error)}). Use ` +
          '`memoryRecordDriver()` if losing records on reload is acceptable.',
      );
    }

    resolved = candidate;
    return resolved;
  }

  const itemKey = (collection: string, id: string) => `${PREFIX}${collection}\u0000${id}`;

  /** Every record in a collection, in no particular order. */
  function scan(collection: string): StoredRecord[] {
    const store = storage();
    const prefix = `${PREFIX}${collection}\u0000`;
    const records: StoredRecord[] = [];

    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (!key?.startsWith(prefix)) continue;
      const raw = store.getItem(key);
      if (raw !== null) records.push(JSON.parse(raw) as StoredRecord);
    }

    return records;
  }

  return {
    async put(collection, record) {
      // Serializing is also the defensive copy: nothing the caller does to `record` afterwards
      // reaches what was stored.
      storage().setItem(itemKey(collection, record.id), JSON.stringify(record));
    },

    async get(collection, id) {
      const raw = storage().getItem(itemKey(collection, id));
      return raw === null ? null : (JSON.parse(raw) as StoredRecord);
    },

    async delete(collection, id) {
      storage().removeItem(itemKey(collection, id));
    },

    async list(collection, partition) {
      return scan(collection)
        .filter((record) => record.partition === partition)
        .sort((a, b) => a.seq - b.seq);
    },

    async clearPartition(collection, partition) {
      // Keys collected first and removed after: removing while walking `key(index)` shifts the
      // indices under the loop and skips every other record.
      const doomed = scan(collection)
        .filter((record) => record.partition === partition)
        .map((record) => itemKey(collection, record.id));
      for (const key of doomed) storage().removeItem(key);
    },

    async partitions(collection) {
      return [...new Set(scan(collection).map((record) => record.partition))].sort();
    },

    async highestSeq(collection) {
      return scan(collection).reduce((highest, record) => Math.max(highest, record.seq), 0);
    },
  };
}
