import type { FragmentManifest } from '@braidlabs/gateway';
import type { SnapshotStore } from './store.js';
import type { RegistrySnapshot } from './snapshot.js';
import { verifySnapshot } from './snapshot.js';

export interface SnapshotRegistryOptions {
  /** Where published snapshots live. */
  store: SnapshotStore;
  /**
   * The snapshot to serve. Omit it to follow the store's `head` — convenient in development, and
   * the wrong choice in production, where a deploy should name the exact configuration it runs.
   */
  pinned?: string;
  /**
   * Follow a named environment instead of HEAD — `'production'` serves what was promoted to
   * production, not what was last published. With `registryRefreshMs`, a promotion goes live on
   * the next reload. Ignored when `pinned` is set.
   */
  environment?: string;
  /**
   * A second store, written through on every successful resolve and read from when the primary
   * store cannot be reached.
   *
   * For this to survive a restart it must be durable — a filesystem store on the instance's disk,
   * an image layer, a config volume. An in-memory cache is useless here: the failure it exists to
   * cover is a *cold* boot against an unreachable store, when nothing has been cached yet.
   */
  cache?: SnapshotStore;
  /**
   * What to do when the pinned snapshot cannot be resolved from the primary store.
   *
   * - `last-known-good` (default) — serve the cached copy, and report it.
   * - `fail` — throw. Correct when serving stale routing is worse than serving nothing.
   */
  fallback?: 'last-known-good' | 'fail';
  /**
   * Whether to recompute the content address and reject a snapshot whose id does not match its
   * content. Defaults to true.
   */
  verify?: boolean;
  /** Called with what happened, for logging. Never called on the request path — see below. */
  onDiagnostic?: (diagnostic: SnapshotDiagnostic) => void;
}

export interface SnapshotDiagnostic {
  level: 'info' | 'warn';
  event: 'resolved' | 'served-from-cache' | 'cache-write-failed' | 'head-followed';
  snapshotId?: string;
  message: string;
  cause?: unknown;
}

/**
 * A gateway `RegistrySource` backed by immutable snapshots.
 *
 * ```ts
 * createGateway({
 *   registry: snapshotRegistry({
 *     store,
 *     pinned: process.env.BRAID_REGISTRY_SNAPSHOT,
 *     cache: fileSnapshotStore({ directory: '/var/cache/braid' }),
 *   }),
 * });
 * ```
 *
 * **When it runs.** The gateway's `Registry` loads its source on the first request that needs a
 * manifest, and then only when it is told to reload — on its `registryRefreshMs` timer, or a call
 * to `gateway.refreshRegistry()`. So:
 *
 * 1. The request path does not depend on the store's availability past boot, which is the point.
 * 2. Without `registryRefreshMs`, a re-pin takes effect on **restart** — the snapshot model's "a
 *    config change is a deploy". With it, a gateway following HEAD picks up a re-pin on its next
 *    reload (hot re-pin), and a `pinned` gateway stays exactly where it is.
 * 3. A reload while HEAD has not moved costs one `head()` call: the snapshot already being served
 *    is not fetched or verified again, and the gateway sees the same manifests and changes nothing.
 * 4. A reload that fails — the store is down, the new snapshot does not verify — leaves the
 *    current snapshot serving. It never falls back to an older cached one.
 */
/**
 * A registry source that also hands out the whole snapshot it is serving — shells included — so a
 * gateway's `documents` hook renders shells from the same snapshot its fragments come from.
 */
export type SnapshotRegistrySource = (() => Promise<FragmentManifest[]>) & {
  /** The snapshot this source last loaded, resolving one first if nothing has loaded yet. */
  snapshot(): Promise<RegistrySnapshot>;
  /**
   * The snapshot a manifests array this source returned came from. The gateway passes the array
   * it is actually serving to its `documents` hook, and this maps it back — so a shell is rendered
   * from the snapshot the gateway accepted, even if a later load was refused.
   */
  snapshotFor(manifests: readonly FragmentManifest[]): RegistrySnapshot | undefined;
};

export function snapshotRegistry(options: SnapshotRegistryOptions): SnapshotRegistrySource {
  const { store, pinned, environment, cache, fallback = 'last-known-good', verify = true, onDiagnostic } = options;
  if (environment !== undefined && !pinned && !store.ref) {
    throw new Error(`braid-registry: following environment "${environment}" needs a store with environment support`);
  }

  /** The snapshot being served, and the manifests handed to the gateway for it. */
  let current: { snapshot: RegistrySnapshot; manifests: FragmentManifest[] } | undefined;
  /** Every manifests array handed out, back to its snapshot — weak, so old ones are collected. */
  const origins = new WeakMap<readonly FragmentManifest[], RegistrySnapshot>();

  const load = async (): Promise<FragmentManifest[]> => {
    const snapshot = await resolve();
    // The same array for the same snapshot, which is how the gateway tells "nothing changed" apart
    // from a re-pin without comparing manifests.
    if (current?.snapshot.id !== snapshot.id) {
      current = { snapshot, manifests: [...snapshot.manifests] };
      origins.set(current.manifests, snapshot);
    }
    return current.manifests;
  };

  return Object.assign(load, {
    // The snapshot the gateway last loaded — not a fresh HEAD lookup, which would let a shell move
    // ahead of the fragments it slots between two registry reloads.
    async snapshot(): Promise<RegistrySnapshot> {
      if (!current) await load();
      return current!.snapshot;
    },
    snapshotFor(manifests: readonly FragmentManifest[]): RegistrySnapshot | undefined {
      return origins.get(manifests);
    },
  });

  async function resolve(): Promise<RegistrySnapshot> {
    let id = pinned;
    let primaryError: unknown;

    try {
      if (!id) {
        id = (environment !== undefined ? await store.ref!(environment) : await store.head?.()) ?? undefined;
        if (!id) {
          throw new Error(
            environment !== undefined
              ? `braid-registry: environment "${environment}" points at nothing yet — promote a snapshot into it first`
              : 'braid-registry: no snapshot pinned and the store reports no head — ' +
                  'pass `pinned` with a snapshot id, or publish one first',
          );
        }
        // Reported when HEAD moves, not on every reload: on a short refresh interval this would
        // otherwise be a heartbeat in the log.
        if (current?.snapshot.id !== id) {
          report({
            level: 'info',
            event: 'head-followed',
            snapshotId: id,
            message: environment !== undefined ? `following environment ${environment} at ${id}` : `following store head ${id}`,
          });
        }
      }

      // Already serving it: nothing to fetch or verify again.
      if (current?.snapshot.id === id) return current.snapshot;

      const snapshot = await store.get(id);
      if (!snapshot) throw new Error(`braid-registry: snapshot "${id}" is not in the store`);
      await assertIntact(snapshot);

      report({ level: 'info', event: 'resolved', snapshotId: id, message: `resolved snapshot ${id}` });
      void writeThrough(snapshot);
      return snapshot;
    } catch (error) {
      primaryError = error;
    }

    if (fallback === 'fail' || !cache || !id) throw primaryError;

    const cached = await cache.get(id).catch(() => null);
    if (!cached) throw primaryError;
    await assertIntact(cached);

    report({
      level: 'warn',
      event: 'served-from-cache',
      snapshotId: id,
      message: `the registry store is unreachable; serving snapshot ${id} from cache`,
      cause: primaryError,
    });
    return cached;
  }

  async function assertIntact(snapshot: RegistrySnapshot): Promise<void> {
    if (!verify) return;
    if (!(await verifySnapshot(snapshot))) {
      // Not staleness — a snapshot whose content does not match its id has been altered, and
      // serving it would quietly change which fragments compose which pages.
      throw new Error(
        `braid-registry: snapshot "${snapshot.id}" failed content verification — ` +
          'its manifests do not hash to its id, so it has been altered in storage or transit',
      );
    }
  }

  async function writeThrough(snapshot: RegistrySnapshot): Promise<void> {
    if (!cache) return;
    try {
      await cache.put(snapshot);
      // the cache's HEAD mirrors the store's; an environment's pointer is not HEAD
      if (environment === undefined) await cache.setHead?.(snapshot.id);
    } catch (cause) {
      // A cache that cannot be written is a degraded fallback, not a failed boot.
      report({
        level: 'warn',
        event: 'cache-write-failed',
        snapshotId: snapshot.id,
        message: `could not write snapshot ${snapshot.id} to the local cache`,
        cause,
      });
    }
  }

  function report(diagnostic: SnapshotDiagnostic): void {
    onDiagnostic?.(diagnostic);
  }
}
