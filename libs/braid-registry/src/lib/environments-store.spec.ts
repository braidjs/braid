import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memorySnapshotStore, type SnapshotStore } from './store.js';
import { fileSnapshotStore } from './file-store.js';
import { createSnapshot } from './snapshot.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))));

const stores: [string, () => Promise<SnapshotStore>][] = [
  ['memory', async () => memorySnapshotStore()],
  [
    'file',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'braid-envs-'));
      directories.push(directory);
      return fileSnapshotStore({ directory });
    },
  ],
];

describe.each(stores)('%s store environments', (_name, make) => {
  it('points each environment at its own snapshot, beside HEAD, and logs every move', async () => {
    const store = await make();
    const a = await createSnapshot({ manifests: [{ id: 'a', endpoint: 'https://a.internal' }] });
    const b = await createSnapshot({ manifests: [{ id: 'b', endpoint: 'https://b.internal' }] });
    await store.put(a);
    await store.put(b);
    await store.setHead?.(b.id);

    await store.setRef!('staging', a.id, 'ada@example.com');
    await store.setRef!('staging', b.id, 'grace@example.com');
    await store.setRef!('production', a.id);

    expect(await store.head?.()).toBe(b.id);
    expect(await store.ref!('staging')).toBe(b.id);
    expect(await store.ref!('production')).toBe(a.id);
    expect(await store.ref!('canary')).toBeNull();
    expect((await store.refLog!('staging')).map((move) => [move.id, move.by])).toEqual([
      [b.id, 'grace@example.com'],
      [a.id, 'ada@example.com'],
    ]);
  });

  it('holds one pending promotion per environment, and clears it', async () => {
    const store = await make();
    const pending = { id: 'reg_0123456789abcdef', base: null, requestedBy: 'ada@example.com', requestedAt: new Date(0).toISOString() };

    await store.setPending!('production', pending);
    expect(await store.pending!('production')).toEqual(pending);
    expect(await store.pending!('staging')).toBeNull();

    await store.setPending!('production', null);
    expect(await store.pending!('production')).toBeNull();
  });

  it('refuses an environment name that could escape the store', async () => {
    const store = await make();
    const a = await createSnapshot({ manifests: [] });
    await store.put(a);

    await expect(store.setRef!('../HEAD', a.id)).rejects.toThrow(/invalid environment/);
    expect(await store.ref!('../HEAD')).toBeNull();
  });
});
