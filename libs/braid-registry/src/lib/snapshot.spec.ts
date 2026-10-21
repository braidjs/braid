import { describe, expect, it } from 'vitest';
import type { FragmentManifest } from '@braidlabs/gateway';
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
