import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FragmentManifest } from '@braidlabs/gateway';
import { fileSnapshotStore } from './file-store.js';
import type { ShellManifest } from './shell.js';
import { createSnapshot, parseSnapshot, serializeSnapshot, verifySnapshot } from './snapshot.js';

const billing: FragmentManifest = { id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] };
const reviews: FragmentManifest = { id: 'reviews', endpoint: 'https://reviews.internal' };

describe('registry snapshots', () => {
  // A literal, not a computed expectation: every snapshot id already in someone's store depends on
  // this algorithm. If this fails, existing pins stop resolving — change the code, not the id.
  it('keeps the content address of a manifests-only snapshot stable', async () => {
    const snapshot = await createSnapshot({ manifests: [billing, reviews] });

    expect(snapshot.id).toBe('reg_bc25abc511812088f248a24bb2b8d78b');
  });

  it('addresses by content, so the same manifests are the same snapshot', async () => {
    const a = await createSnapshot({ manifests: [billing, reviews] });
    const b = await createSnapshot({ manifests: [billing, reviews] });

    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^reg_[0-9a-f]{32}$/);
  });

  it('is order-independent — registration order is not configuration', async () => {
    const a = await createSnapshot({ manifests: [billing, reviews] });
    const b = await createSnapshot({ manifests: [reviews, billing] });

    expect(a.id).toBe(b.id);
  });

  it('ignores publish metadata, so republishing unchanged config is a no-op', async () => {
    const a = await createSnapshot({ manifests: [billing], createdAt: '2026-01-01T00:00:00.000Z', labels: { by: 'ada' } });
    const b = await createSnapshot({ manifests: [billing], createdAt: '2026-08-14T00:00:00.000Z', labels: { by: 'grace' } });

    expect(a.id).toBe(b.id);
    expect(a.createdAt).not.toBe(b.createdAt);
  });

  it('changes id when any manifest field changes', async () => {
    const a = await createSnapshot({ manifests: [billing] });
    const b = await createSnapshot({ manifests: [{ ...billing, pierce: ['/billing/*', '/invoices/*'] }] });

    expect(a.id).not.toBe(b.id);
  });

  it('serializes canonically, so key order cannot change the bytes', async () => {
    const snapshot = await createSnapshot({ manifests: [billing] });
    const reordered = {
      manifests: snapshot.manifests,
      createdAt: snapshot.createdAt,
      id: snapshot.id,
    } as typeof snapshot;

    expect(serializeSnapshot(reordered)).toBe(serializeSnapshot(snapshot));
  });

  it('round-trips through serialize/parse', async () => {
    const snapshot = await createSnapshot({ manifests: [billing, reviews] });
    const parsed = parseSnapshot(serializeSnapshot(snapshot));

    expect(parsed).toEqual(snapshot);
    expect(await verifySnapshot(parsed)).toBe(true);
  });

  it('fails verification when the content has been altered', async () => {
    const snapshot = await createSnapshot({ manifests: [billing] });
    const tampered = {
      ...snapshot,
      manifests: [{ ...billing, endpoint: 'https://attacker.example' }],
    };

    expect(await verifySnapshot(tampered)).toBe(false);
  });

  it('rejects json that is not a snapshot', () => {
    expect(() => parseSnapshot('{"nope":true}')).toThrow(/not a registry snapshot/);
  });
});

describe('snapshots with shells', () => {
  const storefront: ShellManifest = {
    id: 'storefront',
    framework: 'react',
    routes: [{ path: '/billing/*', layout: { areas: 'header\nmain' }, slots: { main: 'billing' } }],
  };

  it('addresses an empty shells list exactly as a snapshot without the field', async () => {
    const without = await createSnapshot({ manifests: [billing, reviews] });
    const empty = await createSnapshot({ manifests: [billing, reviews], shells: [] });

    expect(empty.id).toBe('reg_bc25abc511812088f248a24bb2b8d78b');
    expect(empty).not.toHaveProperty('shells');
    expect(serializeSnapshot(empty)).toBe(serializeSnapshot(without));
  });

  it('changes id when a shell is added or changed', async () => {
    const without = await createSnapshot({ manifests: [billing, reviews] });
    const withShell = await createSnapshot({ manifests: [billing, reviews], shells: [storefront] });
    const changed = await createSnapshot({ manifests: [billing, reviews], shells: [{ ...storefront, framework: 'angular' }] });

    expect(withShell.id).not.toBe(without.id);
    expect(changed.id).not.toBe(withShell.id);
  });

  it('is independent of shell order', async () => {
    const other: ShellManifest = { ...storefront, id: 'admin' };
    const a = await createSnapshot({ manifests: [billing], shells: [storefront, other] });
    const b = await createSnapshot({ manifests: [billing], shells: [other, storefront] });

    expect(a.id).toBe(b.id);
    expect(a.shells?.map((s) => s.id)).toEqual(['admin', 'storefront']);
  });

  it('fails verification when a shell has been altered', async () => {
    const snapshot = await createSnapshot({ manifests: [billing], shells: [storefront] });
    const tampered = { ...snapshot, shells: [{ ...storefront, routes: [] }] };

    expect(await verifySnapshot(snapshot)).toBe(true);
    expect(await verifySnapshot(tampered)).toBe(false);
  });

  it('fails verification when shells are stripped', async () => {
    const snapshot = await createSnapshot({ manifests: [billing], shells: [storefront] });
    const stripped = { ...snapshot, shells: undefined };

    expect(await verifySnapshot(stripped)).toBe(false);
  });

  it('rejects shells that are not an array', () => {
    expect(() => parseSnapshot('{"id":"reg_x","manifests":[],"shells":{}}')).toThrow(/shells must be an array/);
  });

  it('round-trips shells through the file store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'braid-snapshots-'));
    try {
      const store = fileSnapshotStore({ directory });
      const snapshot = await createSnapshot({ manifests: [billing], shells: [storefront] });
      await store.put(snapshot);

      const read = await store.get(snapshot.id);
      expect(read).toEqual(snapshot);
      expect(read && (await verifySnapshot(read))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
