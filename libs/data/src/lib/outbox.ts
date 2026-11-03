import { versioned } from '@braidlabs/skew';
import type { RecordDriver } from './record-store.js';
import { createRecordStore, type ProjectedRecord } from './record-store.js';

/**
 * The offline mutation outbox: durable, shared across every app on the origin, and **owned**.
 *
 * Ownership is the correctness fix, not a refinement. Previously the queue was a single blob under
 * one key, so two applications on one origin overwrote each other's; the second would rehydrate the
 * first's entries, find no registered runner for them, and **drop the user's unsent work** through a
 * reporting hook that was optional. An entry that names its owner is instead simply left alone by
 * everyone else, and waits.
 *
 * One record per entry, so enqueue is a `put` and dequeue is a `delete`. Nothing reads before
 * writing, so nothing can be lost to a concurrent writer.
 */

/**
 * What a queued entry predicts about a record while it waits.
 *
 * Data, not a closure, for the same reason `input` is: the overlay has to be reconstructible by a
 * build that never ran the code which queued it. A shallow patch over the confirmed value is the
 * most an entry can promise honestly — anything richer would be a function, and a function cannot
 * survive a reload.
 */
export interface OptimisticOverlay {
  /** The query key this entry changes. */
  key: string;
  /** Applied over the confirmed record while the entry is queued. */
  patch: Record<string, unknown>;
  /**
   * The tenant partition this prediction belongs to.
   *
   * The queue is deliberately *session*-scoped — a queued write belongs to the session that made it,
   * not to whichever client was on screen — but the **overlay is not**. Without this, an advisor with
   * an unsent trade for one client sees it applied to the identically-keyed record of the next client
   * they open, in another tab, because the two share a record key and a queue.
   *
   * Absent on entries written before this existed, which keeps their overlay behaving as it did.
   */
  partition?: string;
  /**
   * True when the write deletes the record rather than changing it.
   *
   * A patch cannot express absence, and a deletion a reader cannot see is a row that stays on
   * screen after the user removed it — so the overlay carries the fact rather than leaving each
   * reader to infer it from an empty patch.
   */
  removed?: boolean;
}

export interface OutboxEntry {
  /** Identifies the mutation *kind*, so the owner can find its runner. */
  mutationId: string;
  /** Replayable input. Never a closure — the build that replays may not be the one that queued. */
  input: unknown;
  attempts: number;
  queuedAt: string;
  lastError?: string;
  /**
   * Contract version of `input`, when the caller declares one.
   *
   * Distinct from the envelope's version, which covers this entry's own shape: an entry queued
   * under one deploy and replayed against a later one may need its *payload* migrated before it
   * can be sent, and only the caller knows which contract that payload belongs to.
   */
  schemaVersion?: number;
  /**
   * What readers should show until this entry is confirmed.
   *
   * A list because one write routinely changes more than one record — accept an order and the
   * position moves too — and an entry that could only predict one of them would leave the rest of
   * the screen showing values the user has already changed.
   */
  optimistic?: OptimisticOverlay[];
}

interface OutboxEntryV1 {
  mutationId: string;
  input: unknown;
  attempts: number;
  queuedAt: string;
  lastError?: string;
  schemaVersion?: number;
}

interface OutboxEntryV2 extends OutboxEntryV1 {
  optimistic?: OptimisticOverlay[];
}

/**
 * The entry contract, versioned from the first commit.
 *
 * A queued mutation can outlive the build that queued it — the user goes offline, the app deploys,
 * they come back. So even this small internal shape gets an envelope: a shared store is a shared
 * contract, and treating it as "just some JSON" because it is internal is how a coordination layer
 * becomes a fate-sharing vector.
 *
 * v2 adds the overlay. An entry queued by v1 migrates up without one and simply does not tint any
 * reader's view — which is the honest answer, since that build never recorded what it predicted.
 * The queue itself is unaffected either way, so an old entry still sends.
 */
export const OutboxEntrySchema = versioned<OutboxEntryV1>('skew-outbox-entry').next<OutboxEntryV2>(
  'carry the optimistic overlay',
  {
    up: (entry) => entry,
    down: ({ optimistic: _optimistic, ...rest }) => rest,
    lossy: ['optimistic'],
  },
);

export interface QueuedEntry extends OutboxEntry {
  id: string;
  owner: string;
  seq: number;
  /** Whose queue it was written to. Removing or failing it acts there, whoever is signed in now. */
  partition: string;
}

export interface OutboxOptions {
  driver: RecordDriver;
  /** Which fragment or app this instance speaks for. Only its own entries are replayable by it. */
  owner: string;
  /**
   * Which person's queue this is. Read on every call when it is a function.
   *
   * Pass `() => tenancy.partition()` and add the outbox collection to the tenancy's `collections`
   * on any device more than one person signs in to. Entries then belong to the person who queued
   * them: the next person's flush never replays them under their own session, and sign-out purges
   * them. The constant default suits a single-user device only: `owner` separates apps, not people.
   */
  partition?: string | (() => string);
  buildId?: string;
  collection?: string;
}

export interface Outbox {
  /** Queues a mutation, returning its id. */
  enqueue(entry: {
    mutationId: string;
    input: unknown;
    id?: string;
    schemaVersion?: number;
    optimistic?: OptimisticOverlay[];
  }): Promise<string>;
  /**
   * Every queued overlay for a key, oldest first, **whoever owns it**.
   *
   * Ownership governs who may *send* an entry; it does not govern who may see its effect. A user
   * who typed a name into one app and looks at another expects to see the name they typed, and an
   * overlay filtered by owner would show them the stale value with no indication why.
   *
   * Tenancy is the one thing that *does* filter. Pass the partition being read and an overlay
   * belonging to a different one is left out — same key, different client, different answer.
   */
  pendingFor(key: string, partition?: string): Promise<OptimisticOverlay[]>;
  /** Entries this instance owns and may replay, oldest first. */
  mine(): Promise<QueuedEntry[]>;
  /**
   * Every entry in the queue, whoever owns it.
   *
   * What "3 unsent changes" is counted from — a page-wide fact needs a page-wide read, and each app
   * answering only for itself is how the indicator became wrong in the first place.
   */
  all(): Promise<QueuedEntry[]>;
  /** Entries owned by someone else. They are waiting, not stuck, and must not be replayed here. */
  foreign(): Promise<QueuedEntry[]>;
  /**
   * Removes an entry from the partition it was written to (or `partition`, when given), not
   * whichever is current: a send that finishes after a tenant switch must still clear the entry it
   * sent, or switching back replays it.
   */
  remove(id: string, partition?: string): Promise<void>;
  /** Records a failed attempt, keeping the entry queued. Acts where `remove` would. */
  recordFailure(id: string, error: string, partition?: string): Promise<number>;
}

const DEFAULT_COLLECTION = 'outbox';
const DEFAULT_PARTITION = 'session';

export function createOutbox(options: OutboxOptions): Outbox {
  const configured = options.partition ?? DEFAULT_PARTITION;
  const partition = typeof configured === 'function' ? configured : () => configured;
  // Where each entry this instance has written or listed lives, so remove and recordFailure act
  // there even after the current partition has moved on.
  const placed = new Map<string, string>();
  const partitionOf = (id: string, given?: string) => given ?? placed.get(id) ?? partition();
  const store = createRecordStore<OutboxEntryV2>({
    driver: options.driver,
    collection: options.collection ?? DEFAULT_COLLECTION,
    schema: OutboxEntrySchema,
    ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
  });

  const toQueued = (record: ProjectedRecord<OutboxEntryV2>): QueuedEntry => ({
    id: record.id,
    partition: record.partition,
    owner: record.owner ?? '',
    seq: record.seq,
    ...record.value,
  });

  async function entries(): Promise<QueuedEntry[]> {
    const listed = (await store.list(partition())).map(toQueued);
    for (const entry of listed) placed.set(entry.id, entry.partition);
    return listed;
  }

  return {
    async enqueue({ mutationId, input, id, schemaVersion, optimistic }) {
      const entryId = id ?? crypto.randomUUID();
      const at = partition();
      await store.put({
        id: entryId,
        partition: at,
        owner: options.owner,
        value: {
          mutationId,
          input,
          attempts: 0,
          queuedAt: new Date().toISOString(),
          ...(schemaVersion === undefined ? {} : { schemaVersion }),
          ...(optimistic === undefined ? {} : { optimistic }),
        },
      });
      placed.set(entryId, at);
      return entryId;
    },

    async pendingFor(key, forPartition) {
      return (await entries()).flatMap((entry) =>
        (entry.optimistic ?? []).filter(
          (overlay) =>
            overlay.key === key &&
            // An overlay that names no partition predates this and applies as it always did.
            (overlay.partition === undefined || forPartition === undefined || overlay.partition === forPartition),
        ),
      );
    },

    async mine() {
      return (await entries()).filter((entry) => entry.owner === options.owner);
    },

    all: entries,

    async foreign() {
      return (await entries()).filter((entry) => entry.owner !== options.owner);
    },

    async remove(id, at) {
      await store.delete(id, partitionOf(id, at));
      placed.delete(id);
    },

    async recordFailure(id, error, at) {
      const record = await store.get(id, partitionOf(id, at));
      // Already gone — a concurrent flush removed it. Not an error worth raising: the entry is in
      // the state the caller wanted it in.
      if (!record) return 0;

      const attempts = record.value.attempts + 1;
      await store.put({
        id,
        partition: record.partition,
        ...(record.owner === undefined ? {} : { owner: record.owner }),
        // Preserved so a retry does not jump the queue ahead of entries queued after it.
        seq: record.seq,
        value: { ...record.value, attempts, lastError: error },
      });
      return attempts;
    },
  };
}
