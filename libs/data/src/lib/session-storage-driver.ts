import { storageKey, type RecordDriver, type StoredRecord } from './record-store.js';

export interface SessionStorageDriverOptions {
  /** Injectable for tests. Defaults to `globalThis.sessionStorage`, looked up on first use. */
  storage?: Storage;
}

const PREFIX = 'skew:data:';

/**
 * `sessionStorage`, for records that should outlive a reload but not the tab.
 *
 * The cases are narrower than they look: a checkout in progress, a wizard's draft, state that should
 * survive a reload but not be shared with the user's other tabs. Anything the user would mind losing
 * when the tab closes belongs in IndexedDB instead.
 *
 * **Private to the tab is not the same as unique to it.** Browsers copy `sessionStorage` into a
 * duplicated tab, and Chromium into a tab opened from this one. Both then hold the same records —
 * which, for an outbox, means the same queued writes, each sent once per copy. Keep the outbox here
 * only if every mutation it carries is safe to send twice.
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
      // The NUL keeps the probe out of every collection's key space and anyone else's.
      candidate.setItem(`${PREFIX}\u0000probe`, '1');
      candidate.removeItem(`${PREFIX}\u0000probe`);
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

  /**
   * The collection's key prefix. A collection name containing the separator would make one
   * collection's keys a prefix of another's, so reads leak across and purges miss — refused instead.
   */
  function collectionPrefix(collection: string): string {
    if (collection.includes('\u0000')) {
      throw new Error(`skew-data: collection names cannot contain U+0000 (got ${JSON.stringify(collection)})`);
    }
    return `${PREFIX}${collection}\u0000`;
  }

  const itemKey = (collection: string, id: string) => `${collectionPrefix(collection)}${id}`;

  /** Keys in the tab's storage that start with `prefix`. Collected up front: see `clearPartition`. */
  function keysWith(prefix: string): string[] {
    const store = storage();
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    return keys;
  }

  /**
   * Every record in a collection, in no particular order.
   *
   * Items that do not parse as a record are skipped rather than thrown. The storage is shared by
   * every fragment on the origin, so something else — an older build, another library — writing
   * under this prefix is realistic, and one bad item must not take the whole collection with it:
   * a `seq` that is not a number, for one, would poison ordering for every later write.
   */
  function scan(collection: string): StoredRecord[] {
    const records: StoredRecord[] = [];
    for (const key of keysWith(collectionPrefix(collection))) {
      const record = parse(storage().getItem(key));
      if (record) records.push(record);
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
      return parse(storage().getItem(itemKey(collection, id)));
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
      // Selected by key, not by parsing: a record's id is `storageKey(partition, key)`, so the
      // partition is already in the item key, and a corrupt item cannot stand in the way of a
      // sign-out purge. Keys are collected first and removed after, because removing while walking
      // `key(index)` shifts the indices under the loop and skips every other item.
      for (const key of keysWith(itemKey(collection, storageKey(partition, '')))) storage().removeItem(key);
    },

    async partitions(collection) {
      return [...new Set(scan(collection).map((record) => record.partition))].sort();
    },

    async highestSeq(collection) {
      return scan(collection).reduce((highest, record) => Math.max(highest, record.seq), 0);
    },
  };
}

/** A stored item as a record, or `null` when it is missing or is not shaped like one. */
function parse(raw: string | null): StoredRecord | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredRecord> | null;
    const shaped =
      typeof value === 'object' &&
      value !== null &&
      typeof value.id === 'string' &&
      typeof value.key === 'string' &&
      typeof value.partition === 'string' &&
      Number.isFinite(value.seq);
    return shaped ? (value as StoredRecord) : null;
  } catch {
    return null;
  }
}
