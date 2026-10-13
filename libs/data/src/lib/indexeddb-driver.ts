import type { RecordDriver, StoredRecord } from './record-store.js';

export interface IndexedDbDriverOptions {
  /** Database name. One per application is normal; collections are object stores within it. */
  database?: string;
  /** Collections to create. IndexedDB can only create stores during a version upgrade. */
  collections: readonly string[];
  /** Injectable for tests. */
  indexedDB?: IDBFactory;
  /**
   * Injectable for tests, alongside `indexedDB`.
   *
   * Both are needed to substitute the implementation: `IDBKeyRange` is a separate global rather than
   * something reachable from the factory, so injecting only the factory leaves the range queries
   * reaching for whatever the environment happens to have — which is nothing, outside a browser.
   */
  keyRange?: typeof IDBKeyRange;
}

const PARTITION_INDEX = 'by-partition-seq';

/**
 * IndexedDB, as the source of truth.
 *
 * Why this rather than a KV shim over the same database: every operation below is **one
 * transaction over one record**. There is no read-modify-write anywhere, so two realms or two tabs
 * writing concurrently cannot lose each other's work — which a `get`-then-`set` shim absolutely can,
 * whatever storage sits underneath it.
 *
 * The `[partition, seq]` compound index is what makes `list` a range scan rather than a full read
 * plus filter, and it is why partitions stay cheap as the store grows.
 */
export function indexedDbRecordDriver(options: IndexedDbDriverOptions): RecordDriver {
  const databaseName = options.database ?? 'skew-data';
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const collections = [...options.collections];
  const ranges = options.keyRange ?? globalThis.IDBKeyRange;

  let open: Promise<IDBDatabase> | null = null;

  function database(): Promise<IDBDatabase> {
    open ??= connect();
    return open;
  }

  /**
   * Opens the database, upgrading only if a declared collection is actually missing.
   *
   * **The version is discovered, never derived.** An earlier draft opened at
   * `collections.length + 1`, which works perfectly for one application and breaks the moment two
   * share an origin — which is exactly what this library is for. Two independently deployed apps
   * rarely declare the same number of collections, so each would demand its own version: the one
   * with the shorter list ends up requesting a version *lower* than the database already has, and
   * IndexedDB answers that with a `VersionError` forever. Not a race, not intermittent — that app
   * simply never opens its storage again.
   *
   * Discovering it instead means the two converge. Each opens at whatever version exists, adds only
   * the stores it is missing, and the version climbs monotonically as fragments arrive.
   */
  async function connect(): Promise<IDBDatabase> {
    if (!factory) throw new Error('skew-data: no IndexedDB in this environment');

    let db = await openDatabase();
    const missing = collections.filter((collection) => !db.objectStoreNames.contains(collection));

    if (missing.length > 0) {
      // A connection has to be closed before it can be upgraded, including our own.
      db.close();
      db = await openDatabase(db.version + 1);
    }

    /**
     * Stand aside when another context needs to upgrade.
     *
     * This is the other half of sharing a database, and the half that hangs rather than throws when
     * it is missing: a sibling fragment declaring a collection we do not have must upgrade, and an
     * upgrade cannot start while anyone holds the database open. Closing here lets it proceed; the
     * next operation reopens at the new version, by which point its store exists.
     */
    db.onversionchange = () => {
      db.close();
      open = null;
    };

    return db;
  }

  function openDatabase(version?: number): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = version === undefined ? factory!.open(databaseName) : factory!.open(databaseName, version);

      request.onupgradeneeded = () => {
        const db = request.result;
        for (const collection of collections) {
          if (db.objectStoreNames.contains(collection)) continue;
          const store = db.createObjectStore(collection, { keyPath: 'id' });
          store.createIndex(PARTITION_INDEX, ['partition', 'seq']);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('skew-data: could not open the database'));

      // Someone is holding the database open at an older version and did not stand aside. Every
      // connection this driver makes closes itself on `versionchange`, so the holder is something
      // else — an old build, another library, or a devtools inspection. Reported rather than left
      // to hang, because a promise that never settles is the least debuggable failure there is.
      request.onblocked = () =>
        reject(
          new Error(
            `skew-data: another connection is holding "${databaseName}" open at an older version, ` +
              `so it cannot be upgraded to add ${collections.join(', ')}. Close other tabs of this ` +
              `application, or reload them.`,
          ),
        );
    });
  }

  /**
   * Object stores can only be created during a version upgrade, so a collection that was not
   * declared cannot be created on demand — and IndexedDB reports that as a bare `NotFoundError`
   * naming neither the collection nor the fix. Checking first turns an opaque failure into an
   * actionable one, which is worth the branch.
   */
  function assertDeclared(db: IDBDatabase, collection: string): void {
    if (db.objectStoreNames.contains(collection)) return;
    throw new Error(
      `skew-data: collection "${collection}" is not in this database. IndexedDB can only create ` +
        `object stores during a version upgrade, so every collection must be declared up front — ` +
        `add it to \`collections\` where the driver is created (currently: ${collections.join(', ') || 'none'}).`,
    );
  }

  async function transaction<T>(
    collection: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await database();
    assertDeclared(db, collection);
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(collection, mode);
      const request = run(tx.objectStore(collection));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error(`skew-data: ${collection} operation failed`));
    });
  }

  return {
    async put(collection, record) {
      await transaction(collection, 'readwrite', (store) => store.put(record));
    },

    async get(collection, id) {
      return (await transaction<StoredRecord | undefined>(collection, 'readonly', (store) => store.get(id))) ?? null;
    },

    async delete(collection, id) {
      await transaction(collection, 'readwrite', (store) => store.delete(id));
    },

    async list(collection, partition) {
      // Range scan over [partition, seq] — already ordered, so no sort and no full read.
      const range = ranges.bound([partition, -Infinity], [partition, Infinity]);
      return transaction<StoredRecord[]>(collection, 'readonly', (store) =>
        store.index(PARTITION_INDEX).getAll(range),
      );
    },

    async clearPartition(collection, partition) {
      const db = await database();
      assertDeclared(db, collection);
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(collection, 'readwrite');
        const store = tx.objectStore(collection);
        const range = ranges.bound([partition, -Infinity], [partition, Infinity]);
        const cursor = store.index(PARTITION_INDEX).openCursor(range);

        cursor.onsuccess = () => {
          const position = cursor.result;
          if (!position) return;
          position.delete();
          position.continue();
        };

        // Resolved on the transaction, not the cursor: deleting through a cursor is only durable
        // once the transaction commits, and a sign-out purge that reported success before that
        // could leave a partition half-deleted.
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('skew-data: purge failed'));
        tx.onabort = () => reject(tx.error ?? new Error('skew-data: purge aborted'));
      });
    },

    async partitions(collection) {
      const db = await database();
      assertDeclared(db, collection);
      return new Promise<string[]>((resolve, reject) => {
        const found = new Set<string>();
        const tx = db.transaction(collection, 'readonly');
        // A key cursor over the [partition, seq] index: keys only, so no record is deserialized to
        // learn which partition it belongs to. Every key is still visited — skipping ahead a
        // partition at a time is possible, but not worth the code until a collection is large
        // enough for it to show.
        const cursor = tx.objectStore(collection).index(PARTITION_INDEX).openKeyCursor();

        cursor.onsuccess = () => {
          const position = cursor.result;
          if (!position) return resolve([...found].sort());
          found.add((position.key as [string, number])[0]);
          position.continue();
        };
        cursor.onerror = () => reject(cursor.error ?? new Error('skew-data: could not list partitions'));
      });
    },

    async highestSeq(collection) {
      const db = await database();
      assertDeclared(db, collection);
      return new Promise<number>((resolve, reject) => {
        const tx = db.transaction(collection, 'readonly');
        const cursor = tx.objectStore(collection).index(PARTITION_INDEX).openCursor(null, 'prev');

        cursor.onsuccess = () => {
          const record = cursor.result?.value as StoredRecord | undefined;
          resolve(record?.seq ?? 0);
        };
        cursor.onerror = () => reject(cursor.error ?? new Error('skew-data: could not read the sequence'));
      });
    },
  };
}
