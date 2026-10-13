import type { SkewFailureReason, VersionedSchema } from '@braidlabs/skew';
import type { ProjectedRecord, RecordDriver } from './record-store.js';
import { createRecordStore, type RecordStore } from './record-store.js';
import { sharedInvalidator, type Invalidator } from './invalidation.js';
import { withLock } from './locks.js';
import type { OptimisticOverlay, Outbox } from './outbox.js';
import type { PushConnection, PushRecord } from './adapters.js';
import { drainOutbox, type FlushResult, type MutationRunner } from './flush.js';

/**
 * The read path: reactive queries over a shared, persisted, skew-tolerant cache.
 *
 * Three things make this different from an ordinary query cache, and each is the reason for a
 * decision below:
 *
 * 1. **The cache is shared across applications**, because it lives in storage rather than in one
 *    app's memory. Two independently deployed apps asking for the same record fetch it once
 *    between them.
 * 2. **Records are projected per reader.** The store holds what the writer wrote; each reader
 *    migrates it to its own contract version on the way out, in either direction.
 * 3. **Provenance travels with the value.** A reader can tell a field the server reported from one
 *    a migration guessed, which is the entire reason to build on the migration engine rather than
 *    on a plain cache.
 *
 * A fourth follows from the outbox: **the optimistic view is derived, never stored.**
 *
 *     view(record) = confirmed(record) ⊕ pending(record)
 *
 * Both inputs are shared, so every app and every tab derives the same view without reconciling
 * anything, rollback is deletion rather than an undo record to keep consistent, and the queue and
 * the overlay cannot disagree because they are one thing.
 */

export type QueryStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * A confirmation that disagreed with what the overlay predicted.
 *
 * The stored record always becomes the server's value — it is the source of truth, and there is no
 * client-wins option because you cannot make a server hold your value without another mutation.
 * What is configurable is whether the *user* is told.
 */
export interface Conflict<T> {
  /** What the overlay predicted: the confirmed value with this mutation's patch applied. */
  expected: T;
  /** What the server actually stored. */
  actual: T;
  /** The patched paths the server disagreed about. */
  paths: readonly string[];
}

export interface QueryState<T> {
  data: T | undefined;
  status: QueryStatus;
  error?: unknown;
  /** True while a fetch is in flight behind data that is already displayable. */
  refreshing: boolean;
  /** True when this value came from the shared cache rather than the network. */
  fromCache: boolean;
  /** Set when the stored record was older than this reader and was migrated up. */
  migratedFrom: number | null;
  /** Set when it was newer and was projected down — the value is honest but lossy. */
  downgradedFrom: number | null;
  /** Paths whose values are the migration's guesses rather than what the writer recorded. */
  derivedPaths: readonly string[];
  /** Paths a down-projection discarded. */
  lossyPaths: readonly string[];
  /**
   * Set when the stored record could not be read by this reader, and why.
   *
   * The interesting value is `'ahead'`: a record written by a build newer than this one, with no
   * down-migration available. The record is perfectly good and merely from the future — so the
   * honest move is to say so and refetch at this reader's own version, rather than discard it as
   * corrupt or guess at fields the writer never sent.
   */
  unreadable: SkewFailureReason | null;
  /** True while an optimistic overlay is applied — `data` includes work the server has not seen. */
  pending: boolean;
  /** Set when a confirmation disagreed with the overlay, under the `'raise'` policy. */
  conflict: Conflict<T> | null;
}

export interface Query<T> {
  readonly current: QueryState<T>;
  subscribe(listener: (state: QueryState<T>) => void): () => void;
  /** Forces a fetch, bypassing the cache. */
  refetch(): Promise<void>;
  dispose(): void;
}

export interface QueryDefinition<T> {
  /** Cache key. Identifies the record, and is what makes two apps share one fetch. */
  key: string;
  /** What this query depends on, for invalidation. */
  tags?: string[];
  schema: VersionedSchema<T>;
  fetch: (signal: AbortSignal) => Promise<unknown>;
  /**
   * Serve the cached value immediately and refresh behind it. Defaults to true — a warm partition
   * is the point of persisting, and waiting on the network to show data you already have discards
   * it.
   */
  staleWhileRevalidate?: boolean;
}

/**
 * One change to the client's collection.
 *
 * `'clear'` has no key: it is the whole partition going at once, and reporting it as a delete per
 * record would mean reading every record back just to say it was gone.
 */
export interface RecordChange {
  type: 'put' | 'delete' | 'clear';
  collection: string;
  partition: string;
  /** The caller's id. Absent for `'clear'`. */
  key?: string;
}

export interface CollectionQueryDefinition<T> {
  /** The reader's contract. Records it cannot project are left out, as `RecordStore.list` does. */
  schema: VersionedSchema<T>;
}

export interface CollectionState<T> {
  /** Every readable record in the current partition, in `seq` order. */
  data: ProjectedRecord<T>[] | undefined;
  status: QueryStatus;
  error?: unknown;
}

/**
 * A live view of a whole collection in the current partition.
 *
 * Read from storage only — it never goes to the network. Something else puts records there (key
 * queries, mutations, a push stream), and this re-reads whenever any of them does, in this client,
 * another client, or another context sharing the invalidator.
 */
export interface CollectionQuery<T> {
  readonly current: CollectionState<T>;
  subscribe(listener: (state: CollectionState<T>) => void): () => void;
  dispose(): void;
}

export interface DataClientOptions {
  driver: RecordDriver;
  /**
   * The tenant partition: `hash(userId, actingAs)`.
   *
   * Read on every access rather than captured, so switching tenants is a pointer move and the
   * previous partition stays warm on disk.
   */
  partition: () => string;
  collection?: string;
  buildId?: string;
  /**
   * Let invalidation reach other JavaScript contexts — other tabs, and **other realms on this
   * page**. Off by default.
   *
   * Turn it on whenever this app is composed with others: a Braid realm is its own context, so
   * without the channel a sibling fragment never hears that a record went stale, and staleness is
   * invisible.
   */
  crossContextInvalidation?: boolean;
  /** Called whenever the network is actually hit. What the demo's "fetched once" counter reads. */
  onFetch?: (key: string) => void;
  invalidator?: Invalidator;
  /**
   * The queue that also supplies the optimistic overlay. Without one, `mutate` has nowhere to
   * record a write it cannot yet send, so queries show only confirmed values.
   */
  outbox?: Outbox;
  /**
   * How many times a queued write is retried before it is abandoned.
   *
   * Abandoned loudly through `onFlushError`, never silently: the user was told it saved.
   */
  maxAttempts?: number;
  /** Reports a queued write that could not be replayed. Wire it to telemetry. */
  onFlushError?: (message: string, detail?: unknown) => void;
  /**
   * Flush the queue when the browser comes back online, and once at construction.
   *
   * Defaults to true whenever an outbox is supplied — a queue nothing drains is durability without
   * delivery, which is the worse half of the feature.
   */
  autoFlush?: boolean;
}

export type { FlushResult, MutationRunner };

export interface MutationRegistration {
  /** Marked stale after a successful replay, as `mutate` would have done at the time. */
  tags?: string[];
}

/** What to do when the server's value disagrees with what the overlay predicted. */
export type ConflictPolicy<T> = 'raise' | 'accept' | ((conflict: Conflict<T>) => T);

export interface MutationDefinition<T> {
  /** The record this changes. The same key its queries read, or nothing overlays. */
  key: string;
  schema: VersionedSchema<T>;
  /**
   * Identifies the mutation *kind*. A queued entry outlives the closure that made it, and after a
   * reload this is how it finds its runner again.
   */
  mutationId: string;
  /** Replayable input for that runner. */
  input: unknown;
  /** Applied over the confirmed record until the server answers. */
  patch: Partial<T>;
  /** Set when the write deletes the record: readers show it gone before the server agrees. */
  removes?: boolean;
  /**
   * Sends it. Resolves with the server's version of the record.
   *
   * Takes the input rather than closing over it, because this same function is what replays the
   * write if the send fails: a queued entry stores data, and the runner it is handed back to must
   * be able to work from that data alone.
   */
  send: (input: unknown) => Promise<unknown>;
  /** Tags to mark stale once the write lands. */
  tags?: string[];
  /**
   * Defaults to `'raise'`, because the silent version changes the screen under someone who just
   * typed something. "I set it to X, why does it say Y?" is a support ticket, and in an advisory
   * context it is a support ticket about someone's money. Silence is opted into per mutation, by a
   * team that knows the field is server-authoritative.
   */
  onConflict?: ConflictPolicy<T>;
  /** Contract version of `input`, carried on the queued entry. */
  schemaVersion?: number;
}

export interface MutationOutcome<T> {
  /** `'queued'` means the send failed and the entry is waiting; the overlay stays applied. */
  status: 'confirmed' | 'queued';
  /** The outbox entry this created. Still queued when `status` is `'queued'`. */
  entryId: string;
  /** What was stored. Absent while queued — nothing has been confirmed yet. */
  value?: T;
  conflict?: Conflict<T>;
  /** Why the send failed, when it did. */
  error?: unknown;
}

export interface DataClient {
  query<T>(definition: QueryDefinition<T>): Query<T>;
  /**
   * Every record in the current partition, kept current as the collection changes.
   *
   * Confirmed records only: optimistic overlays are applied per key by `query`, not here.
   */
  collection<T>(definition: CollectionQueryDefinition<T>): CollectionQuery<T>;
  /**
   * The change feed for this client's collection: every put, delete and partition clear that goes
   * through this client, as it lands. Returns a disposer.
   *
   * Typed events reach only this client's listeners. Other clients and contexts hear that the
   * collection changed — their `collection` queries re-read — but not what the change was, because
   * the invalidation channel carries tags rather than payloads.
   */
  watch(listener: (change: RecordChange) => void): () => void;
  /**
   * Writes: queue, overlay, send, confirm.
   *
   * Optimistic and offline are the same mechanism here rather than two features that must be kept
   * in agreement — a mutation whose send fails is simply one whose overlay outlives the attempt.
   */
  mutate<T>(definition: MutationDefinition<T>): Promise<MutationOutcome<T>>;
  /** Dismisses a raised conflict, once the user has seen it. */
  acknowledgeConflict(key: string): void;
  /**
   * Teaches the client how to replay a kind of write.
   *
   * `mutate` registers its own `send` automatically, so the live path needs no call. This exists
   * for the path that has no live closure left: **after a reload**, a queued entry knows its
   * `mutationId` and its input and nothing else, so the application must re-register its mutation
   * kinds during start-up or the queue has nowhere to go.
   */
  registerMutation(mutationId: string, runner: MutationRunner, options?: MutationRegistration): void;
  /**
   * Drains the queue, oldest first.
   *
   * Called automatically when the browser comes back online unless `autoFlush` is off; call it
   * directly after signing in, or behind a "retry now" button.
   */
  flush(): Promise<FlushResult>;
  /**
   * Connects a push stream — a subscription, socket, or SSE feed — to the store.
   *
   * Server-pushed records land through the same enveloping path as everything else, and readers are
   * refreshed *from storage* rather than sent back to the network: the pushed record already is the
   * newest thing anyone has. Returns a disposer.
   */
  connect<T>(connection: PushConnection<T>): () => void;
  /** Marks tags stale across every app on the page. */
  invalidate(...tags: string[]): void;
  /** Drops a tenant's cached records. Sign-out, or a tenant switch that should not stay warm. */
  clearPartition(partition?: string): Promise<void>;
  close(): void;
}

const DEFAULT_COLLECTION = 'entities';

/**
 * The tag a key's overlay changes travel on.
 *
 * Ordinary tags mean "this data is stale, go and look again"; this one means "the pending set
 * moved, recompute the view you already have". Sharing one tag space would make every keystroke of
 * optimistic state a network refetch.
 */
function pendingTag(key: string): string {
  return `skew:pending#${key}`;
}

/**
 * The tag a collection's changes travel on. Like `pendingTag`, it means "re-read storage", never
 * "refetch": whatever changed has already been written.
 */
function collectionTag(collection: string): string {
  return `skew:collection#${collection}`;
}

export function createDataClient(options: DataClientOptions): DataClient {
  const collection = options.collection ?? DEFAULT_COLLECTION;
  // Shared per partition, so a mutation in one application refreshes another's view of the same
  // record. A private invalidator per client would make cross-app invalidation silently not work.
  const invalidator =
    options.invalidator ??
    sharedInvalidator({
      partition: options.partition(),
      ...(options.crossContextInvalidation === undefined
        ? {}
        : { crossContext: options.crossContextInvalidation }),
    });

  const stores = new Map<VersionedSchema<unknown>, RecordStore<unknown>>();

  /**
   * Raised conflicts, per key, held by the client that wrote.
   *
   * Deliberately not shared: the app whose user typed the value is the one that can explain what
   * happened to it. Broadcasting "someone, somewhere, was disagreed with" to five fragments gives
   * four of them a message they cannot act on.
   */
  const conflicts = new Map<string, Conflict<unknown>>();

  /** Why a key's stored record could not be read, last time anyone tried. */
  const unreadable = new Map<string, SkewFailureReason>();

  /** How to replay each kind of queued write. Populated by `mutate` and by `registerMutation`. */
  const runners = new Map<string, { run: MutationRunner; tags?: string[] }>();
  const maxAttempts = options.maxAttempts ?? 5;

  const watchers = new Set<(change: RecordChange) => void>();

  /**
   * Tells this client's watchers what changed, and everyone else that something did.
   *
   * The second half is what keeps another app's collection view current: it shares the
   * invalidator, not this client's listeners.
   */
  function changed(change: RecordChange): void {
    for (const watcher of [...watchers]) {
      try {
        watcher(change);
      } catch {
        // One watcher throwing must not keep the change from the others, or from the invalidator.
      }
    }
    invalidator.invalidate(collectionTag(collection));
  }

  /**
   * One store per schema, because the store *is* the projection: the same bytes read through two
   * chains give two different values, which is the point.
   */
  function storeFor<T>(schema: VersionedSchema<T>): RecordStore<T> {
    let store = stores.get(schema as VersionedSchema<unknown>);
    if (!store) {
      store = createRecordStore<unknown>({
        driver: options.driver,
        collection,
        schema: schema as VersionedSchema<unknown>,
        ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
        // Recorded per key rather than thrown: a record this reader cannot project is a fact about
        // the pair of them, and the query that asked is the only place that can act on it.
        onReadFailure: (id, failure) => void unreadable.set(id, failure.reason),
        // Every write the client makes goes through a store — query fetches, confirmed mutations,
        // pushed records — so this one hook is the whole feed.
        onWrite: (write) => changed({ ...write, collection }),
      });
      stores.set(schema as VersionedSchema<unknown>, store);
    }
    return store as RecordStore<T>;
  }

  /**
   * Drains this client's queue, oldest first, under the same per-owner lock the outbox uses.
   *
   * Three rules, each with a failure behind it:
   *
   * - **Strictly sequential.** Queued writes routinely depend on each other — create a thing, then
   *   rename the thing — and replaying them in parallel races them into the wrong order.
   * - **A failure stops the drain** rather than skipping ahead, for the same reason.
   * - **An entry with no runner is not silently dropped.** It means the app did not re-register that
   *   mutation kind after a reload, or renamed it between deploys. Dropping it quietly discards a
   *   write the user was told had saved, so it is reported and left queued for a build that knows
   *   what it is.
   */
  /**
   * Serializes *this client's* own flushes.
   *
   * The Web Lock declines a flush another tab is already running, which is right: waiting for it
   * would drain a queue that tab has already emptied. But applied to one client's own overlapping
   * calls that rule is a trap — construct a client, queue a write, call `flush()`, and the
   * start-up flush is very likely still finishing, so the caller's flush reports `skipped` and
   * quietly does nothing. Within one client, a second flush waits for the first and then runs,
   * picking up anything queued in between.
   */
  let flushing: Promise<FlushResult> | null = null;

  async function flush(): Promise<FlushResult> {
    if (flushing) await flushing.catch(() => undefined);

    const run = drain();
    flushing = run;
    try {
      return await run;
    } finally {
      if (flushing === run) flushing = null;
    }
  }

  function drain(): Promise<FlushResult> {
    const outbox = options.outbox;
    if (!outbox) return Promise.resolve({ sent: 0, failed: 0, remaining: 0, skipped: false });

    return drainOutbox({
      outbox,
      // The collection names this application's queue, and the flush lock is per owner.
      owner: options.collection ?? DEFAULT_COLLECTION,
      runnerFor: (mutationId) => runners.get(mutationId)?.run,
      maxAttempts,
      ...(options.onFlushError === undefined ? {} : { onError: options.onFlushError }),
      onSent: (entry) => {
        // The overlay lifts with the entry; whatever the write invalidated at the time is marked
        // stale again, now that the server has actually seen it.
        const keys = (entry.optimistic ?? []).map((overlay) => overlay.key);
        invalidator.invalidate(...keys.map(pendingTag), ...(runners.get(entry.mutationId)?.tags ?? []));
      },
      onAbandoned: (entry) => {
        // Nothing will send it now, so the prediction it was showing has to come off the screen.
        const keys = (entry.optimistic ?? []).map((overlay) => overlay.key);
        invalidator.invalidate(...keys.map(pendingTag));
      },
    });
  }

  /**
   * A queue nothing drains is durability without delivery, so a client given an outbox flushes on
   * its own: once now, for whatever a previous session left behind, and again whenever the browser
   * says the network is back.
   *
   * `online` is a hint rather than a fact — it fires for a captive portal too — but a flush that
   * finds the network still down simply leaves the queue where it was.
   */
  if (options.outbox && (options.autoFlush ?? true)) {
    void flush().catch(() => undefined);

    const view = globalThis as { addEventListener?: typeof addEventListener };
    view.addEventListener?.('online', () => void flush().catch(() => undefined));
  }

  return {
    query<T>(definition: QueryDefinition<T>): Query<T> {
      return createQuery(definition, {
        store: storeFor(definition.schema),
        partition: options.partition,
        invalidator,
        conflicts,
        unreadable,
        ...(options.onFetch === undefined ? {} : { onFetch: options.onFetch }),
        ...(options.outbox === undefined ? {} : { outbox: options.outbox }),
      });
    },

    collection<T>(definition: CollectionQueryDefinition<T>): CollectionQuery<T> {
      return createCollectionQuery(storeFor(definition.schema), {
        partition: options.partition,
        invalidator,
        tag: collectionTag(collection),
      });
    },

    watch(listener) {
      watchers.add(listener);
      return () => void watchers.delete(listener);
    },

    async mutate<T>(definition: MutationDefinition<T>): Promise<MutationOutcome<T>> {
      const outbox = options.outbox;
      if (!outbox) {
        throw new TypeError(
          '[skew/data] mutate() needs an `outbox` on the client: the overlay it applies and the ' +
            'queue that survives a failed send are the same records, so there is nowhere to put ' +
            'the write without one.',
        );
      }

      // Registered on the way in, so a send that fails has a runner waiting for it before anyone
      // asks — including a flush triggered by the network returning a second later.
      runners.set(definition.mutationId, {
        run: definition.send,
        ...(definition.tags === undefined ? {} : { tags: definition.tags }),
      });

      const store = storeFor(definition.schema);
      const partition = options.partition();
      const confirmed = (await store.get(definition.key, partition))?.value;
      const expected = { ...(confirmed ?? {}), ...definition.patch } as T;

      // Queued *before* sending, not on failure. The entry is what readers overlay, so a write that
      // is only recorded once it fails is a write nobody can see while it is in flight.
      const entryId = await outbox.enqueue({
        mutationId: definition.mutationId,
        input: definition.input,
        optimistic: [
          {
            key: definition.key,
            // Stamped so the prediction is only ever shown to the tenant it was made for.
            partition,
            patch: definition.patch as Record<string, unknown>,
            ...(definition.removes ? { removed: true } : {}),
          },
        ],
        ...(definition.schemaVersion === undefined ? {} : { schemaVersion: definition.schemaVersion }),
      });
      invalidator.invalidate(pendingTag(definition.key));

      let actual: T;
      try {
        actual = (await definition.send(definition.input)) as T;
      } catch (error) {
        // The entry stays queued and the overlay stays applied: from the user's point of view the
        // change happened, and the queue is what will eventually make that true.
        return { status: 'queued', entryId, error };
      }

      const policy = definition.onConflict ?? 'raise';
      const paths = disagreements(expected, actual, Object.keys(definition.patch));
      let stored = actual;
      let conflict: Conflict<T> | undefined;

      if (paths.length > 0) {
        if (typeof policy === 'function') stored = policy({ expected, actual, paths });
        else if (policy === 'raise') conflict = { expected, actual, paths };
      }

      await store.put({ id: definition.key, partition, value: stored });
      await outbox.remove(entryId);

      if (conflict) conflicts.set(definition.key, conflict as Conflict<unknown>);
      else conflicts.delete(definition.key);

      // The pending tag first so the overlay lifts against the value just stored; the caller's tags
      // after, for the queries that depend on this record without reading this key.
      invalidator.invalidate(pendingTag(definition.key), ...(definition.tags ?? []));

      return { status: 'confirmed', entryId, value: stored, ...(conflict ? { conflict } : {}) };
    },

    acknowledgeConflict(key) {
      if (!conflicts.delete(key)) return;
      invalidator.invalidate(pendingTag(key));
    },

    registerMutation(mutationId, runner, registration) {
      runners.set(mutationId, {
        run: runner,
        ...(registration?.tags === undefined ? {} : { tags: registration.tags }),
      });
    },

    flush,

    connect<T>(connection: PushConnection<T>): () => void {
      const store = storeFor(connection.schema);
      const controller = new AbortController();

      const sink = {
        async receive(record: PushRecord) {
          if (controller.signal.aborted) return;
          // The stream's own answer wins when it has one: a socket carrying several tenants' events
          // knows which tenant each belongs to, and the reader's current partition does not.
          const target = record.partition ?? options.partition();
          await store.put({ id: record.key, partition: target, value: record.value as T });

          // The pending tag, not the record's own: this refreshes readers from the store, where the
          // value already is. Marking the record stale would answer a push by fetching the thing the
          // push just delivered.
          invalidator.invalidate(
            pendingTag(record.key),
            ...(record.tags ?? connection.tags?.(record.key) ?? []),
          );
        },
      };

      const disposer = connection.source(sink, controller.signal);

      return () => {
        controller.abort();
        // A stream may report its disposer synchronously or after connecting; both are settled here
        // so a caller never has to know which transport it was handed.
        void Promise.resolve(disposer).then((dispose) => dispose?.());
      };
    },

    invalidate(...tags) {
      invalidator.invalidate(...tags);
    },

    async clearPartition(partition) {
      const target = partition ?? options.partition();
      await options.driver.clearPartition(collection, target);
      changed({ type: 'clear', collection, partition: target });
    },

    close() {
      watchers.clear();
      invalidator.close();
    },
  };
}

function createQuery<T>(
  definition: QueryDefinition<T>,
  context: {
    store: RecordStore<T>;
    partition: () => string;
    invalidator: Invalidator;
    conflicts: Map<string, Conflict<unknown>>;
    unreadable: Map<string, SkewFailureReason>;
    onFetch?: (key: string) => void;
    outbox?: Outbox;
  },
): Query<T> {
  const listeners = new Set<(state: QueryState<T>) => void>();
  const controller = new AbortController();
  const staleWhileRevalidate = definition.staleWhileRevalidate ?? true;

  let state: QueryState<T> = {
    data: undefined,
    status: 'idle',
    refreshing: false,
    fromCache: false,
    migratedFrom: null,
    downgradedFrom: null,
    derivedPaths: [],
    lossyPaths: [],
    unreadable: null,
    pending: false,
    conflict: null,
  };

  const emit = (next: Partial<QueryState<T>>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener(state);
  };

  /**
   * Reads the view: the stored record with every queued patch for this key applied over it.
   *
   * Patches are applied in queue order, so two edits to the same field settle the way they will
   * settle on the server. The overlay is recomputed from the outbox on every read rather than
   * accumulated, which is what makes rollback a deletion — remove the entry and the next read
   * simply does not include it.
   */
  async function readView(): Promise<boolean> {
    context.unreadable.delete(definition.key);
    const record = await context.store.get(definition.key, context.partition());
    const failure = context.unreadable.get(definition.key) ?? null;
    // An overlay needs something to sit on. A patch alone is not a record — it names the fields one
    // write changed, not every field this reader's contract requires.
    if (!record) {
      // Reported before returning, so a reader that is behind learns *why* it is about to refetch
      // rather than watching an apparently empty cache go back to the network.
      if (failure) emit({ unreadable: failure });
      return false;
    }

    const overlays: OptimisticOverlay[] = context.outbox
      ? await context.outbox.pendingFor(definition.key, context.partition())
      : [];
    const data = overlays.reduce<T | undefined>(
      (value, overlay) => (overlay.removed ? undefined : ({ ...(value ?? {}), ...overlay.patch } as T)),
      record.value,
    );

    emit({
      data,
      status: 'ready',
      fromCache: true,
      migratedFrom: record.migratedFrom,
      downgradedFrom: record.downgradedFrom,
      derivedPaths: record.derivedPaths,
      lossyPaths: record.lossyPaths,
      unreadable: null,
      pending: overlays.length > 0,
      conflict: (context.conflicts.get(definition.key) as Conflict<T> | undefined) ?? null,
    });
    return true;
  }

  /**
   * Fetches, under a per-key lock, re-checking the cache once it is held.
   *
   * The lock is what makes "these two apps fetched this once between them" true even when they ask
   * *simultaneously*. Realms are separate JavaScript contexts, so an in-process in-flight map
   * cannot dedupe across them; `navigator.locks` can, and the second app finds the record already
   * written when its turn comes.
   */
  async function fetchAndStore(force: boolean): Promise<void> {
    if (controller.signal.aborted) return;
    emit({ refreshing: true, ...(state.data === undefined ? { status: 'loading' as const } : {}) });

    try {
      await withLock(
        `skew:data:fetch:${context.partition()}:${definition.key}`,
        async () => {
          if (controller.signal.aborted) return;
          // Double-checked: another context may have fetched while this one waited for the lock.
          if (!force && (await readView())) return;

          context.onFetch?.(definition.key);
          const raw = await definition.fetch(controller.signal);
          if (controller.signal.aborted) return;

          await context.store.put({ id: definition.key, partition: context.partition(), value: raw as T });
          await readView();
          emit({ fromCache: false });
        },
        { ifAvailable: false },
      );
    } catch (error) {
      if (!controller.signal.aborted) {
        // Cached data survives a failed refresh: showing something stale beats showing nothing,
        // and `status` says which it is.
        emit({ status: state.data === undefined ? 'error' : 'ready', error });
      }
    } finally {
      if (!controller.signal.aborted) emit({ refreshing: false });
    }
  }

  const unsubscribe = context.invalidator.subscribe(
    () => definition.tags ?? [],
    () => void fetchAndStore(true),
    { signal: controller.signal },
  );

  /**
   * Overlay changes recompute the view; they never refetch.
   *
   * A separate subscription rather than another tag on the one above, because the pending set moves
   * on every keystroke a user's edits generate and the record it applies to has not gone stale —
   * routing that through the fetch path would answer "someone typed" with a network request.
   */
  const unsubscribePending = context.invalidator.subscribe(
    () => [pendingTag(definition.key)],
    () => void readView(),
    { signal: controller.signal },
  );

  /**
   * Kick off: serve the cache when there is one, then decide whether to go to the network.
   *
   * A cache miss always fetches. A hit fetches only when revalidating — `staleWhileRevalidate:
   * false` means *do not go back to the network for something already held*, and an earlier version
   * of this had it backwards, force-refetching precisely when told not to. That is invisible when
   * every reader agrees about the data and very visible when they do not: the refetch overwrote a
   * record written by a newer app with the older reader's own shape.
   */
  void (async () => {
    const hit = await readView();
    if (!hit || staleWhileRevalidate) await fetchAndStore(hit);
  })().catch((error: unknown) => {
    // Reading the partition is the throw that lands here: a query created after sign-out cannot
    // say where to look. Reported as an error *state* rather than an unhandled rejection, because
    // the caller has a subscriber and no promise to catch — and an app that renders its query
    // states will show this one without being taught anything new.
    if (!controller.signal.aborted) emit({ status: 'error', error });
  });

  return {
    get current() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => void listeners.delete(listener);
    },
    refetch: () => fetchAndStore(true),
    dispose() {
      controller.abort();
      unsubscribe();
      unsubscribePending();
      listeners.clear();
    },
  };
}

function createCollectionQuery<T>(
  store: RecordStore<T>,
  context: { partition: () => string; invalidator: Invalidator; tag: string },
): CollectionQuery<T> {
  const listeners = new Set<(state: CollectionState<T>) => void>();
  const controller = new AbortController();
  let state: CollectionState<T> = { data: undefined, status: 'loading' };

  const emit = (next: CollectionState<T>) => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  /**
   * Counts reads so only the newest one lands. Two changes in quick succession start two reads, and
   * nothing makes them finish in order — without this, the older read can overwrite the newer.
   */
  let generation = 0;

  async function read(): Promise<void> {
    const mine = ++generation;
    try {
      const data = await store.list(context.partition());
      if (mine === generation && !controller.signal.aborted) emit({ data, status: 'ready' });
    } catch (error) {
      // Reading the partition throws after sign-out; reported as state, as `createQuery` does.
      if (mine === generation && !controller.signal.aborted) emit({ data: state.data, status: 'error', error });
    }
  }

  context.invalidator.subscribe(() => [context.tag], () => void read(), { signal: controller.signal });
  void read();

  return {
    get current() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => void listeners.delete(listener);
    },
    dispose() {
      controller.abort();
      listeners.clear();
    },
  };
}

/**
 * Which of the patched fields the server did not agree with.
 *
 * Only the patched ones: a server that also touched `updatedAt` did not disagree with anybody, and
 * reporting that as a conflict would train users to dismiss the ones that matter.
 */
function disagreements(expected: unknown, actual: unknown, paths: readonly string[]): string[] {
  const from = (value: unknown) => (value ?? {}) as Record<string, unknown>;
  const before = from(expected);
  const after = from(actual);
  return paths.filter((path) => !same(before[path], after[path]));
}

/**
 * Structural equality, by serialization.
 *
 * Adequate because both sides came off the wire or out of an envelope moments ago — values that
 * survive JSON by construction. A deep-equality helper would be more code defending against inputs
 * this path cannot receive.
 */
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
