import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '@braidlabs/gateway';
import type { FragmentManifest } from '@braidlabs/gateway';
import { createSnapshot } from './snapshot.js';
import { memorySnapshotStore } from './store.js';
import { snapshotRegistry } from './source.js';
import { fileSnapshotStore } from './file-store.js';

/**
 * The integration that matters: a published snapshot is a registry a real gateway serves from.
 * Everything else in this package is bookkeeping in service of this working.
 */
describe('snapshots as a gateway registry', () => {
  const manifests: FragmentManifest[] = [
    { id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] },
  ];

  it('serves fragments from a pinned snapshot', async () => {
    const snapshot = await createSnapshot({ manifests });
    const gateway = createGateway({
      mode: 'production',
      registry: snapshotRegistry({ store: memorySnapshotStore([snapshot]), pinned: snapshot.id }),
    });

    // the realm stub is authored by the gateway from the manifest, so a 200 here means the
    // snapshot resolved and the fragment is registered
    const response = await gateway.handle(new Request('https://shell.example/__braid/realm/billing/'));

    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain('billing');
  });

  it('does not know fragments that are not in the pinned snapshot', async () => {
    const snapshot = await createSnapshot({ manifests });
    const gateway = createGateway({
      mode: 'production',
      registry: snapshotRegistry({ store: memorySnapshotStore([snapshot]), pinned: snapshot.id }),
    });

    const response = await gateway.handle(new Request('https://shell.example/__braid/realm/reviews/'));

    expect(response?.status).toBe(404);
  });

  it('round-trips through the filesystem store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'braid-snapshot-'));
    try {
      const store = fileSnapshotStore({ directory });
      const snapshot = await createSnapshot({ manifests });
      await store.put(snapshot);
      await store.setHead?.(snapshot.id);

      // a fresh store handle, as a restarted process would have
      const gateway = createGateway({
        mode: 'production',
        registry: snapshotRegistry({ store: fileSnapshotStore({ directory }) }),
      });

      const response = await gateway.handle(new Request('https://shell.example/__braid/realm/billing/'));
      expect(response?.status).toBe(200);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a path-traversal snapshot id rather than reading outside its directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'braid-snapshot-'));
    try {
      expect(await fileSnapshotStore({ directory }).get('../../etc/passwd')).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/**
 * Hot re-pin, end to end: a gateway that follows the store's HEAD serves a newly pinned snapshot
 * on its next reload, with no restart — and keeps serving the old one when the store is down.
 */
describe('hot re-pin', () => {
  const billing: FragmentManifest[] = [{ id: 'billing', endpoint: 'https://billing.internal' }];
  const orders: FragmentManifest[] = [{ id: 'orders', endpoint: 'https://orders.internal' }];
  const realm = (gateway: ReturnType<typeof createGateway>, id: string) =>
    gateway.handle(new Request(`https://shell.example/__braid/realm/${id}/`)).then((response) => response?.status);

  it('serves a re-pinned snapshot on the next reload', async () => {
    const a = await createSnapshot({ manifests: billing });
    const b = await createSnapshot({ manifests: orders });
    const store = memorySnapshotStore([a, b]);
    await store.setHead?.(a.id);
    const gateway = createGateway({ mode: 'production', registry: snapshotRegistry({ store }) });

    expect(await realm(gateway, 'billing')).toBe(200);
    await store.setHead?.(b.id);
    await gateway.refreshRegistry();

    expect(await realm(gateway, 'billing')).toBe(404);
    expect(await realm(gateway, 'orders')).toBe(200);
  });

  it('costs one head lookup per reload while nothing has been re-pinned', async () => {
    const a = await createSnapshot({ manifests: billing });
    const store = memorySnapshotStore([a]);
    const get = vi.spyOn(store, 'get');
    const gateway = createGateway({ mode: 'production', registry: snapshotRegistry({ store }) });
    await realm(gateway, 'billing');

    const result = await gateway.refreshRegistry();

    expect(result.changed).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('never moves a pinned gateway', async () => {
    const a = await createSnapshot({ manifests: billing });
    const b = await createSnapshot({ manifests: orders });
    const store = memorySnapshotStore([a, b]);
    const gateway = createGateway({ mode: 'production', registry: snapshotRegistry({ store, pinned: a.id }) });
    await realm(gateway, 'billing');

    await store.setHead?.(b.id);
    await gateway.refreshRegistry();

    expect(await realm(gateway, 'billing')).toBe(200);
    expect(await realm(gateway, 'orders')).toBe(404);
  });

  it('keeps the current snapshot when the store cannot be reached', async () => {
    const a = await createSnapshot({ manifests: billing });
    const store = memorySnapshotStore([a]);
    const gateway = createGateway({ mode: 'production', registry: snapshotRegistry({ store }) });
    await realm(gateway, 'billing');

    vi.spyOn(store, 'head').mockRejectedValue(new Error('store down'));
    await expect(gateway.refreshRegistry()).rejects.toThrow('store down');

    expect(await realm(gateway, 'billing')).toBe(200);
  });
});
