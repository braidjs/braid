import { InjectionToken } from '@angular/core';
import { indexedDbRecordDriver, memoryRecordDriver, type RecordDriver } from '@braidlabs/data';

export interface DataOptions {
  /**
   * Where the outbox is stored. Shared across every app on the origin.
   *
   * A record-oriented driver rather than a key/value store, and that is the correctness fix: the
   * queue used to live under a single key, so appending meant read-modify-write and two apps
   * interleaving lost each other's entries.
   */
  readonly driver: RecordDriver;
  /**
   * Which application this is, stamped onto every entry it queues.
   *
   * The store is shared, so ownership is what keeps one app from acting on another's queued work.
   * Only the owner replays an entry; everyone else leaves it alone.
   */
  readonly owner: string;
  /** Attempts before a queued entry is abandoned. Default 5. */
  readonly maxOutboxAttempts: number;
  /**
   * Reports outbox trouble: an abandoned entry, a mutation this build no longer has, a failed write.
   *
   * Silent by default, but wiring it to telemetry is how you find out that users are losing queued
   * work — the failure is otherwise invisible, because the user already navigated away believing it
   * saved.
   */
  readonly onOutboxError?: (message: string, detail?: unknown) => void;
  /** Flush the outbox when the browser reports it is back online. Default true. */
  readonly flushOnReconnect: boolean;
  readonly buildId?: string;
  /**
   * Whose queue this is: pass `() => tenancy.partition()` on any device more than one person signs
   * in to, and list the outbox collection in that tenancy's `collections`. Queued work then belongs
   * to the person who queued it, the next person's flush never replays it under their session, and
   * sign-out purges it. Without it the queue is device-wide, which suits a single-user device only.
   */
  readonly partition?: string | (() => string);
}

export const DATA_OPTIONS = new InjectionToken<DataOptions>('SKEW_DATA_OPTIONS');

export interface DataOptionsInput {
  /**
   * Identifies this application in the shared outbox. **Required when persisting.**
   *
   * Not defaulted, deliberately. A default would be the same string in every app on the page, which
   * is precisely the collision ownership exists to prevent — and it would fail silently, in
   * production, on someone's unsent work.
   */
  readonly owner?: string;
  /** Supply storage directly. Overrides `persistOutbox`. */
  readonly driver?: RecordDriver;
  readonly maxOutboxAttempts?: number;
  readonly onOutboxError?: DataOptions['onOutboxError'];
  readonly flushOnReconnect?: boolean;
  /**
   * Persist the outbox in IndexedDB, so queued work survives a reload.
   *
   * Off by default: queued work is then lost on reload, which is only appropriate when every
   * mutation is fire-and-forget.
   */
  readonly persistOutbox?: boolean;
  /** Stamped onto persisted envelopes for attribution. */
  readonly buildId?: string;
  /** Whose queue this is. See {@link DataOptions.partition}; set it on any shared device. */
  readonly partition?: string | (() => string);
  /** Database name when persisting. Defaults to `skew-data`. */
  readonly database?: string;
  /**
   * Extra collections to create alongside the outbox.
   *
   * Declared up front because IndexedDB can only create object stores during a version upgrade —
   * a collection used but not declared fails at the first read, not at configuration time.
   */
  readonly collections?: readonly string[];
}

export const OUTBOX_COLLECTION = 'outbox';

/**
 * Whether this environment can persist at all.
 *
 * False during server rendering, where there is no IndexedDB — and no point in one, since the
 * outbox exists to survive a *client* reload. Falling back to memory keeps `persistOutbox: true` a
 * safe thing to write in a config shared by both bootstraps, which is where it naturally goes.
 */
function canPersist(): boolean {
  return typeof globalThis.indexedDB !== 'undefined';
}

function persistentDriver(input: DataOptionsInput) {
  return indexedDbRecordDriver({
    collections: [OUTBOX_COLLECTION, ...(input.collections ?? [])],
    ...(input.database === undefined ? {} : { database: input.database }),
  });
}

export function resolveDataOptions(input: DataOptionsInput = {}): DataOptions {
  const persisting = input.persistOutbox === true || input.driver !== undefined;

  if (persisting && !input.owner) {
    throw new Error(
      '[skew/data] a persisted outbox needs `owner`: a string identifying this application.\n' +
        'The outbox is shared across every app on the origin, and ownership is what stops one app ' +
        "from replaying or discarding another's queued mutations. Defaulting it would put every app " +
        'under the same name, which is the collision it exists to prevent.',
    );
  }

  return {
    driver: input.driver ?? (input.persistOutbox && canPersist() ? persistentDriver(input) : memoryRecordDriver()),
    owner: input.owner ?? 'app',
    maxOutboxAttempts: input.maxOutboxAttempts ?? 5,
    ...(input.onOutboxError === undefined ? {} : { onOutboxError: input.onOutboxError }),
    flushOnReconnect: input.flushOnReconnect ?? true,
    ...(input.buildId === undefined ? {} : { buildId: input.buildId }),
    ...(input.partition === undefined ? {} : { partition: input.partition }),
  };
}
