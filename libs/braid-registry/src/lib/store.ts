import type { RegistrySnapshot } from './snapshot.js';

/**
 * Where snapshots live.
 *
 * Deliberately tiny, and deliberately not a database interface: a snapshot is an immutable
 * document addressed by id, so the only operations that exist are put, get, and enumerate. There
 * is no update and no delete-by-mutation, because there is nothing to mutate.
 *
 * `head` is the one piece of mutable state — the pointer to what was published most recently.
 * Implementations may omit it, in which case callers must pin explicitly.
 */
export interface SnapshotStore {
  get(id: string): Promise<RegistrySnapshot | null>;
  /**
   * Stores a snapshot. Storing an id that already exists is a no-op rather than an error: the
   * content is identical by construction, so a second publish of the same config is not a
   * conflict.
   */
  put(snapshot: RegistrySnapshot): Promise<void>;
  /**
   * Snapshot references, newest first (ties by id, see {@link compareRefs}). `before` is a cursor
   * from {@link refCursor}: list only what comes after that ref, for the next page of history.
   */
  list(options?: { limit?: number; before?: string }): Promise<SnapshotRef[]>;
  /** The most recently published snapshot id, when the store tracks one. */
  head?(): Promise<string | null>;
  setHead?(id: string): Promise<void>;

  /**
   * Named environments — `staging`, `production` — each pointing at a snapshot, beside HEAD. HEAD
   * stays the publish target; an environment moves only by promotion. All optional: a store
   * without them simply has no environments.
   */
  ref?(environment: string): Promise<string | null>;
  /** Points an environment at a snapshot and appends the move to its log. */
  setRef?(environment: string, id: string, by?: string | null): Promise<void>;
  /** An environment's moves, newest first — what a rollback may return it to. */
  refLog?(environment: string, options?: { limit?: number }): Promise<RefMove[]>;
  /** The promotion waiting for approval in an environment, if any. */
  pending?(environment: string): Promise<PendingPromotion | null>;
  setPending?(environment: string, pending: PendingPromotion | null): Promise<void>;
}

export interface RefMove {
  id: string;
  at: string;
  by: string | null;
}

/** A promotion requested into an environment that needs approval before it moves. */
export interface PendingPromotion {
  /** The snapshot to move the environment to. */
  id: string;
  /** What the environment pointed at when this was requested — approval is refused if it moved. */
  base: string | null;
  /** Who asked, as `identify` names them — for display. */
  requestedBy: string;
  /**
   * Who asked, as `subject` identifies them — stable across clients, and what four-eyes is checked
   * against. Absent when the API has no `subject` hook, in which case `requestedBy` is used.
   */
  requestedSubject?: string;
  requestedAt: string;
}

/** Environment names end up in file names and URLs, so they are kept to a short, plain charset. */
export function isEnvironmentName(name: unknown): name is string {
  return typeof name === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(name);
}

export interface SnapshotRef {
  id: string;
  createdAt: string;
  fragmentCount: number;
  labels?: Readonly<Record<string, string>>;
}

/**
 * Listing order: newest first, and by id among snapshots minted in the same millisecond — so a
 * page boundary falls in the same place every time and paging neither skips nor repeats one.
 */
export function compareRefs(a: Pick<SnapshotRef, 'createdAt' | 'id'>, b: Pick<SnapshotRef, 'createdAt' | 'id'>): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

/** A cursor that resumes a listing after `ref`. Opaque to clients. */
export function refCursor(ref: Pick<SnapshotRef, 'createdAt' | 'id'>): string {
  return `${ref.createdAt}~${ref.id}`;
}

/** Whether `ref` lists after the cursor — older, or the same instant and a lower id. */
export function isAfterCursor(ref: Pick<SnapshotRef, 'createdAt' | 'id'>, cursor: string): boolean {
  const split = cursor.lastIndexOf('~');
  if (split < 0) return false;
  return compareRefs(ref, { createdAt: cursor.slice(0, split), id: cursor.slice(split + 1) }) > 0;
}

export function toRef(snapshot: RegistrySnapshot): SnapshotRef {
  return {
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    fragmentCount: snapshot.manifests.length,
    ...(snapshot.labels ? { labels: snapshot.labels } : {}),
  };
}

/**
 * An in-memory store. Useful in tests, in development, and as the cache tier in front of a remote
 * store — it is not durable, so it is never the right primary store for a deployed gateway.
 */
export function memorySnapshotStore(seed: readonly RegistrySnapshot[] = []): SnapshotStore {
  const snapshots = new Map<string, RegistrySnapshot>();
  let head: string | null = null;
  const refs = new Map<string, RefMove[]>();
  const pending = new Map<string, PendingPromotion>();

  for (const snapshot of seed) {
    snapshots.set(snapshot.id, snapshot);
    head = snapshot.id;
  }

  return {
    async get(id) {
      return snapshots.get(id) ?? null;
    },
    async put(snapshot) {
      snapshots.set(snapshot.id, snapshot);
    },
    async list({ limit, before } = {}) {
      const refs = [...snapshots.values()]
        .map(toRef)
        .sort(compareRefs)
        .filter((ref) => before === undefined || isAfterCursor(ref, before));
      return limit === undefined ? refs : refs.slice(0, limit);
    },
    async head() {
      return head;
    },
    async setHead(id) {
      if (!snapshots.has(id)) {
        throw new Error(`braid-registry: cannot point head at unknown snapshot "${id}"`);
      }
      head = id;
    },
    async ref(environment) {
      return refs.get(environment)?.[0]?.id ?? null;
    },
    async setRef(environment, id, by = null) {
      if (!isEnvironmentName(environment)) throw new Error(`braid-registry: invalid environment name "${environment}"`);
      if (!snapshots.has(id)) throw new Error(`braid-registry: cannot point ${environment} at unknown snapshot "${id}"`);
      refs.set(environment, [{ id, at: new Date().toISOString(), by }, ...(refs.get(environment) ?? [])]);
    },
    async refLog(environment, { limit } = {}) {
      const log = refs.get(environment) ?? [];
      return limit === undefined ? [...log] : log.slice(0, limit);
    },
    async pending(environment) {
      return pending.get(environment) ?? null;
    },
    async setPending(environment, value) {
      if (value) pending.set(environment, value);
      else pending.delete(environment);
    },
  };
}
