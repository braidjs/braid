import { versioned } from '@braidlabs/skew';
import { withLock } from './locks.js';
import { copyPartition, type CopyPartitionResult, type PartitionConflictPolicy } from './partitions.js';
import { createRecordStore, type RecordDriver } from './record-store.js';

/**
 * Tenancy: which partition is live, and what sign-out actually destroys.
 *
 * Two identities change independently and both belong in the key:
 *
 * - the **authentication principal** — who is signed in; changing it is a login
 * - the **acting-as tenant** — whose data is being viewed; changing it is a switch
 *
 *     partition = hash(userId, actingAs)
 *
 * `actingAs` is part of the key rather than a dimension inside it. The cost is real — genuinely
 * shared reference data is fetched once per tenant instead of once — and it buys the property that
 * makes persistence-first defensible: a partition is **fully self-contained**. No read crosses a
 * tenant boundary, so switching is a pointer move, purge is complete by construction, and there is
 * no shared slice whose lifetime has to be reasoned about apart from the partitions referencing it.
 *
 * **Encryption at rest is deliberately not here.** A browser key has to live somewhere, and a
 * non-extractable `CryptoKey` in IndexedDB defends against casual inspection but not against code
 * running on the origin — which, on a page composing several fragments, is the realistic threat.
 * Purge-on-sign-out is the honest control; encryption beside it would be theatre.
 */

export interface Principal {
  /** Who is signed in. */
  userId: string;
  /** Whose data is being viewed. Defaults to the user acting as themselves. */
  actingAs?: string;
}

export interface TenancyOptions {
  driver: RecordDriver;
  /**
   * Every collection a partition's records can live in.
   *
   * Enumerated rather than discovered, because a purge that quietly misses a collection is
   * indistinguishable from a purge that worked — until the next user opens the page.
   */
  collections: readonly string[];
  /** Where tenancy's own bookkeeping lives. Never holds application data. */
  metaCollection?: string;
  buildId?: string;
}

export interface Tenancy {
  /**
   * The live partition key.
   *
   * Throws when nobody is signed in, and throws when the active partition is poisoned. Both are
   * refusals to serve rather than empty results: a read that silently returns nothing after
   * sign-out looks exactly like a user with no data.
   */
  partition(): string;
  /** Who is signed in, and as whom. */
  current(): Principal | null;
  /** Activates a principal's partition, recovering any interrupted purge first. */
  signIn(principal: Principal): Promise<string>;
  /** Views another tenant's data. A pointer move — the previous partition stays warm on disk. */
  switchTenant(actingAs: string): Promise<string>;
  /**
   * Purges every partition belonging to the signed-in user, then refuses reads.
   *
   * Session expiry calls this too: an expired session is not a reason to keep the data readable.
   */
  signOut(): Promise<void>;
  /** Re-runs any purge that was interrupted. Called by `signIn`; exposed for start-up. */
  recover(): Promise<void>;
  /** Notified with the new partition, or `null` when nobody is signed in. */
  subscribe(listener: (partition: string | null) => void): () => void;
  /**
   * Brings another partition's records into the active one — the guest who just signed in.
   *
   * ```ts
   * const guest = await tenancy.signIn({ userId: `guest:${deviceId}` });
   * // …they shop, then sign in…
   * await tenancy.signIn({ userId: 'user:ana' });
   * await tenancy.adopt(guest, { collections: ['cart'], mode: 'move' });
   * ```
   *
   * Deliberate rather than automatic. Whether a guest's basket should follow them into an account
   * that may already have one is a question about *your* product — prices, stock reservations, and
   * whose cart wins — and a data layer that answered it for you would be answering it wrong for
   * somebody.
   */
  adopt(from: string, options?: AdoptOptions): Promise<CopyPartitionResult>;
}

export interface AdoptOptions {
  /** Which collections follow the person. Defaults to every collection this tenancy manages. */
  collections?: readonly string[];
  /** Defaults to `'skip'` — the signed-in account's own records win. */
  onConflict?: PartitionConflictPolicy;
  /** `'move'` clears the source afterwards. Defaults to `'copy'`. */
  mode?: 'copy' | 'move';
}

interface TenancyRecordV1 {
  /** `partition` records what exists; `purge` records what is mid-destruction. */
  kind: 'partition' | 'purge';
  userId: string;
  actingAs?: string;
  partition?: string;
  partitions?: string[];
  at: string;
}

/**
 * Bookkeeping is enveloped like everything else.
 *
 * It outlives builds for the same reason application records do: a user signs out on a deploy that
 * is not the one which wrote the marker, and an unversioned marker is precisely the record whose
 * misreading would skip a purge.
 */
export const TenancyRecordSchema = versioned<TenancyRecordV1>('skew-tenancy-record');

const DEFAULT_META_COLLECTION = 'skew-tenancy';
/** Bookkeeping is not tenant data, so it lives in a partition of its own. */
const META_PARTITION = 'meta';

export function createTenancy(options: TenancyOptions): Tenancy {
  const store = createRecordStore<TenancyRecordV1>({
    driver: options.driver,
    collection: options.metaCollection ?? DEFAULT_META_COLLECTION,
    schema: TenancyRecordSchema,
    ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
  });

  const listeners = new Set<(partition: string | null) => void>();
  const poisoned = new Set<string>();
  let principal: Principal | null = null;
  let active: string | null = null;

  const notify = () => {
    for (const listener of [...listeners]) listener(active);
  };

  async function markPartition(userId: string, actingAs: string, partition: string): Promise<void> {
    await store.put({
      id: `partition:${partition}`,
      partition: META_PARTITION,
      value: { kind: 'partition', userId, actingAs, partition, at: new Date().toISOString() },
    });
  }

  /**
   * Destroys the listed partitions across every collection, marker first.
   *
   * The marker is written **before** the first delete and removed after the last, so an interruption
   * anywhere in between is discoverable. A purge that crashes halfway with no record of having
   * started is the failure this exists to prevent: the partition would come back on the next open,
   * half-emptied and served as if it were whole.
   */
  async function purge(userId: string, partitions: readonly string[]): Promise<void> {
    if (partitions.length === 0) return;

    const markerId = `purge:${userId}`;
    await store.put({
      id: markerId,
      partition: META_PARTITION,
      value: { kind: 'purge', userId, partitions: [...partitions], at: new Date().toISOString() },
    });

    const cleared: string[] = [];
    try {
      for (const partition of partitions) {
        for (const collection of options.collections) {
          await options.driver.clearPartition(collection, partition);
        }
        await store.delete(`partition:${partition}`, META_PARTITION);
        poisoned.delete(partition);
        cleared.push(partition);
      }
      await store.delete(markerId, META_PARTITION);
    } catch (error) {
      // The marker stays. Everything it names is unservable until a later `recover()` finishes the
      // job — a partially purged partition must never be read, and the marker is the only durable
      // evidence that it is partial.
      for (const partition of partitions) {
        if (!cleared.includes(partition)) poisoned.add(partition);
      }
      endSessionIfPurged(cleared);
      throw error;
    }

    endSessionIfPurged(cleared);
  }

  /**
   * A sign-out anywhere ends the session everywhere.
   *
   * The other tab that was reading this partition when it was destroyed holds a principal in memory
   * and no reason to doubt it. Left alone it would keep serving a partition that no longer exists,
   * which is a signed-out user still looking at their data — so the tab that discovers the purge
   * ends its own session too. A partition that was *not* confirmed cleared is handled by `poisoned`
   * instead: that one is refused rather than forgotten, because we cannot claim it is gone.
   */
  function endSessionIfPurged(cleared: readonly string[]): void {
    if (!active || !cleared.includes(active)) return;
    principal = null;
    active = null;
    notify();
  }

  async function recover(): Promise<void> {
    const records = await store.list(META_PARTITION);
    const markers = records.filter((record) => record.value.kind === 'purge');

    // A sign-out that *succeeded* elsewhere leaves no marker — it leaves an absence. The partition
    // record is what registration wrote, so its disappearance is how another tab learns its session
    // is over. Checked before the markers, because a failed purge is the noisier case and would
    // otherwise mask this quieter one.
    if (active && !records.some((record) => record.value.kind === 'partition' && record.value.partition === active)) {
      principal = null;
      active = null;
      notify();
    }

    for (const marker of markers) {
      // Poisoned before the attempt, so a second failure leaves the partitions no more readable
      // than the first did.
      for (const partition of marker.value.partitions ?? []) poisoned.add(partition);
      await purge(marker.value.userId, marker.value.partitions ?? []);
    }
  }

  async function activate(next: Principal): Promise<string> {
    const actingAs = next.actingAs ?? next.userId;
    const partition = partitionKey(next.userId, actingAs);

    await markPartition(next.userId, actingAs, partition);
    principal = { userId: next.userId, actingAs };
    active = partition;
    notify();
    return partition;
  }

  return {
    partition() {
      if (!active || !principal) {
        throw new Error(
          '[skew/data] no partition is active: sign in before reading. Reads are refused rather ' +
            'than answered with nothing, because an empty result after sign-out is indistinguishable ' +
            'from a user who has no data.',
        );
      }
      if (poisoned.has(active)) {
        throw new Error(
          `[skew/data] partition "${active}" was left half-purged by an interrupted sign-out and ` +
            'cannot be served. Call recover() — it finishes the purge — then sign in again.',
        );
      }
      return active;
    },

    current: () => (principal ? { ...principal } : null),

    async signIn(next) {
      /**
       * Under the lock sign-out purges with, so a sign-in in another tab waits for that purge to
       * finish instead of re-registering a partition it is in the middle of destroying — which would
       * leave the partition unregistered, out of reach of every later purge, and readable.
       */
      const outcome = await withLock(
        `skew:data:purge:${next.userId}`,
        async () => {
          // Before activation, not after: a partition still named by a marker must not be readable
          // for the window between signing in and noticing.
          await recover();
          return activate(next);
        },
        { ifAvailable: false },
      );
      if (!outcome.acquired) throw new Error('[skew/data] sign-in could not take the purge lock');
      return outcome.value;
    },

    async switchTenant(actingAs) {
      if (!principal) {
        throw new Error('[skew/data] cannot switch tenant before signing in');
      }
      const userId = principal.userId;
      // Under the purge lock, as signIn is: a switch in a tab that has not yet heard about a sign-out
      // elsewhere would otherwise register a new partition while that purge is listing them.
      const outcome = await withLock(
        `skew:data:purge:${userId}`,
        async () => {
          // Checked again inside: the purge this waited for may have been this person's sign-out.
          await recover();
          if (!principal || principal.userId !== userId) {
            throw new Error('[skew/data] cannot switch tenant: the session ended while switching');
          }
          // The previous partition is left exactly as it is. Warm on disk is the point: coming
          // back to it should not re-fetch what was already fetched.
          return activate({ userId, actingAs });
        },
        { ifAvailable: false },
      );
      if (!outcome.acquired) throw new Error('[skew/data] switching tenant could not take the purge lock');
      return outcome.value;
    },

    async signOut() {
      const signedIn = principal;
      // Cleared first, so nothing reads through the partition while it is being destroyed.
      principal = null;
      active = null;
      notify();
      if (!signedIn) return;

      // Held across tabs: a second tab that signs in mid-purge would otherwise re-register the
      // partition being destroyed and serve what is left of it.
      const outcome = await withLock(
        `skew:data:purge:${signedIn.userId}`,
        async () => {
          const records = await store.list(META_PARTITION);
          const partitions = records
            .filter((record) => record.value.kind === 'partition' && record.value.userId === signedIn.userId)
            .map((record) => record.value.partition!)
            .filter(Boolean);
          await purge(signedIn.userId, partitions);
        },
        { ifAvailable: false },
      );

      // `ifAvailable: false` waits for the holder, so this only happens if the environment has no
      // lock manager at all — in which case the purge has not run and must not be reported as done.
      if (!outcome.acquired) {
        throw new Error('[skew/data] sign-out could not take the purge lock; the data was not purged');
      }
    },

    recover,

    subscribe(listener) {
      listeners.add(listener);
      listener(active);
      return () => void listeners.delete(listener);
    },

    async adopt(from, adoptOptions) {
      if (!active || !principal) {
        throw new Error(
          '[skew/data] cannot adopt a partition before signing in: there is no destination to ' +
            'copy into. Sign the user in first, then adopt what their guest session left behind.',
        );
      }

      return copyPartition({
        driver: options.driver,
        from,
        to: active,
        collections: adoptOptions?.collections ?? options.collections,
        ...(adoptOptions?.onConflict === undefined ? {} : { onConflict: adoptOptions.onConflict }),
        ...(adoptOptions?.mode === undefined ? {} : { mode: adoptOptions.mode }),
      });
    },
  };
}

/**
 * The partition key: `hash(userId, actingAs)`.
 *
 * FNV-1a rather than SHA-256 because this is a namespace, not a secret. It has to be synchronous —
 * `partition()` is called on every read — and `crypto.subtle` is not. What hashing does buy is that
 * user and tenant identifiers stay out of every storage key, which is what someone reading the
 * IndexedDB pane sees; the one bookkeeping record that does hold them is itself destroyed at
 * sign-out.
 */
export function partitionKey(userId: string, actingAs: string = userId): string {
  return `p_${fnv1a(userId)}_${fnv1a(actingAs)}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    // The shifts are FNV's 32-bit prime multiply; `>>> 0` keeps it unsigned after each round.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
