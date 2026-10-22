import { describe, expect, it } from 'vitest';
import type { FragmentManifest } from '@braidlabs/gateway';
import { createGateway } from '@braidlabs/gateway';
import { createRegistryApi, type RegistryAction } from './api.js';
import { memorySnapshotStore } from './store.js';
import { createSnapshot } from './snapshot.js';
import { snapshotRegistry } from './source.js';
import type { AuditEvent } from './audit.js';

const BASE = 'https://ops.example/__braid/registry-api';
const v1: FragmentManifest[] = [{ id: 'billing', endpoint: 'https://billing.internal', title: 'v1' }];
const v2: FragmentManifest[] = [{ id: 'billing', endpoint: 'https://billing.internal', title: 'v2' }];

/**
 * staging → production, production needing one approval. Callers are named by `x-actor`, and their
 * rights by `x-rights` (a comma list, environment-scoped rights written `promote:production`).
 */
async function pipeline() {
  const a = await createSnapshot({ manifests: v1 });
  const b = await createSnapshot({ manifests: v2 });
  const store = memorySnapshotStore([a, b]);
  await store.setHead?.(b.id);
  const events: AuditEvent[] = [];
  const api = createRegistryApi({
    store,
    environments: [{ name: 'staging' }, { name: 'production', from: 'staging', approvals: 1 }],
    identify: (request) => request.headers.get('x-actor'),
    authorize: (request, action: RegistryAction, context) => {
      const rights = (request.headers.get('x-rights') ?? '').split(',');
      return rights.includes(action) || (context?.environment !== undefined && rights.includes(`${action}:${context.environment}`));
    },
    audit: (event) => void events.push(event),
  });
  /** The pending request, as an approver would have seen it. */
  const shown = async (environment: string) => {
    const pending = (await (await api.handle(new Request(`${BASE}/environments`, { headers: { 'x-rights': 'read' } })))!.json()).items.find(
      (item: { name: string }) => item.name === environment,
    ).pending;
    return { id: pending.id, requestedAt: pending.requestedAt };
  };
  const call = (path: string, actor: string, rights: string, body: unknown = {}) =>
    api.handle(new Request(`${BASE}${path}`, { method: 'POST', headers: { 'x-actor': actor, 'x-rights': rights }, body: JSON.stringify(body) }));
  const environments = async () =>
    (await (await api.handle(new Request(`${BASE}/environments`, { headers: { 'x-rights': 'read' } })))!.json()).items as {
      name: string;
      id: string | null;
      pending: { id: string; requestedBy: string } | null;
    }[];
  return { api, store, a, b, events, call, environments, shown };
}

describe('environments', () => {
  it('refuses to start with approvals but no way to tell approvers apart', () => {
    expect(() =>
      createRegistryApi({ store: memorySnapshotStore(), authorize: () => true, environments: [{ name: 'production', approvals: 1 }] }),
    ).toThrow(/identify/);
  });

  it('refuses an environment whose source is not configured', () => {
    expect(() =>
      createRegistryApi({ store: memorySnapshotStore(), authorize: () => true, environments: [{ name: 'production', from: 'staging' }] }),
    ).toThrow(/staging/);
  });

  it('promotes HEAD into an environment with no source, and lists where each one points', async () => {
    const { call, environments, b } = await pipeline();

    const response = await call('/environments/staging/promote', 'ada', 'promote:staging');

    expect(response!.status).toBe(200);
    expect(await environments()).toEqual([
      expect.objectContaining({ name: 'staging', id: b.id, pending: null }),
      expect.objectContaining({ name: 'production', id: null, pending: null }),
    ]);
  });

  it('scopes promotion rights by environment', async () => {
    const { call } = await pipeline();

    expect((await call('/environments/staging/promote', 'ada', 'promote:production'))!.status).toBe(403);
    expect((await call('/environments/staging/promote', 'ada', 'promote'))!.status).toBe(200);
  });

  it("only promotes what is in the source environment", async () => {
    const { call, a } = await pipeline();
    await call('/environments/staging/promote', 'ada', 'promote');

    const response = await call('/environments/production/promote', 'ada', 'promote', { id: a.id });

    expect(response!.status).toBe(409);
    expect((await response!.json()).error).toContain('staging');
  });

  it('holds a promotion into a gated environment until someone else approves it', async () => {
    const { call, environments, b, events, shown } = await pipeline();
    await call('/environments/staging/promote', 'ada', 'promote');

    const requested = await call('/environments/production/promote', 'ada', 'promote');
    expect(requested!.status).toBe(202);
    expect((await environments())[1]).toMatchObject({ id: null, pending: { id: b.id, requestedBy: 'ada' } });
    const request = await shown('production');

    // the requester cannot approve their own promotion, whatever rights they hold
    expect((await call('/environments/production/approve', 'ada', 'approve', request))!.status).toBe(403);
    // someone without the approve right cannot either
    expect((await call('/environments/production/approve', 'grace', 'promote', request))!.status).toBe(403);

    const approved = await call('/environments/production/approve', 'grace', 'approve:production', request);
    expect(approved!.status).toBe(200);
    expect((await environments())[1]).toMatchObject({ id: b.id, pending: null });

    expect(events.map((event) => [event.action, event.outcome, event.environment, event.actor])).toEqual(
      expect.arrayContaining([
        ['promote', 'success', 'production', 'ada'],
        ['approve', 'denied', 'production', 'ada'],
        ['approve', 'success', 'production', 'grace'],
      ]),
    );
  });

  it('refuses a second request while one is pending, and lets the requester or an approver reject it', async () => {
    const { call, environments } = await pipeline();
    await call('/environments/staging/promote', 'ada', 'promote');
    await call('/environments/production/promote', 'ada', 'promote');

    expect((await call('/environments/production/promote', 'ada', 'promote'))!.status).toBe(409);
    expect((await call('/environments/production/reject', 'mallory', 'promote'))!.status).toBe(403);
    // withdrawing is the requester's, but only while they may still promote there
    expect((await call('/environments/production/reject', 'ada', 'read'))!.status).toBe(403);
    expect((await call('/environments/production/reject', 'ada', 'promote'))!.status).toBe(200);
    expect((await environments())[1]!.pending).toBeNull();
  });

  it('refuses an approval if the environment moved since it was requested', async () => {
    const { call, store, a, shown } = await pipeline();
    await call('/environments/staging/promote', 'ada', 'promote');
    await call('/environments/production/promote', 'ada', 'promote');
    const request = await shown('production');

    await store.setRef!('production', a.id, 'someone-with-store-access');

    expect((await call('/environments/production/approve', 'grace', 'approve', request))!.status).toBe(409);
  });

  it('rolls an environment back to anything it has served before', async () => {
    const { call, store, a, b } = await pipeline();
    await store.setHead?.(a.id);
    await call('/environments/staging/promote', 'ada', 'promote');
    await store.setHead?.(b.id);
    await call('/environments/staging/promote', 'ada', 'promote');

    const response = await call('/environments/staging/promote', 'ada', 'promote', { id: a.id });

    expect(response!.status).toBe(200);
    expect(await store.ref!('staging')).toBe(a.id);
  });

  it('reports environment rights in /permissions', async () => {
    const { api } = await pipeline();

    const permissions = await (
      await api.handle(new Request(`${BASE}/permissions`, { headers: { 'x-rights': 'read,promote:staging,approve:production' } }))
    )!.json();

    expect(permissions.environments).toEqual({
      staging: { promote: true, approve: false },
      production: { promote: false, approve: true },
    });
  });

  it('serves a gateway following an environment, not HEAD', async () => {
    const { call, store, a, b } = await pipeline();
    await store.setHead?.(a.id);
    await call('/environments/staging/promote', 'ada', 'promote');
    await store.setHead?.(b.id);

    const staging = snapshotRegistry({ store, environment: 'staging' });
    const gateway = createGateway({ mode: 'production', registry: staging });
    const title = async () =>
      (await staging()).find((manifest) => manifest.id === 'billing')?.title;

    expect(await title()).toBe('v1');
    await call('/environments/staging/promote', 'ada', 'promote');
    await gateway.refreshRegistry();
    expect(await title()).toBe('v2');
  });

  it('approves only the request the approver saw — a swapped one is refused', async () => {
    const { call, store, a, b, shown, environments } = await pipeline();
    await call('/environments/staging/promote', 'ada', 'promote');
    await call('/environments/production/promote', 'ada', 'promote');
    const reviewed = await shown('production');

    // ada withdraws and asks again for something else, with the same base
    await call('/environments/production/reject', 'ada', 'promote');
    await store.setRef!('staging', a.id, 'ada');
    await call('/environments/production/promote', 'ada', 'promote');

    expect((await call('/environments/production/approve', 'grace', 'approve', reviewed))!.status).toBe(409);
    expect((await environments())[1]!.id).toBeNull();
    void b;
  });

  it('compares requester and approver by a stable subject, not by a display name', async () => {
    const a = await createSnapshot({ manifests: v1 });
    const store = memorySnapshotStore([a]);
    const api = createRegistryApi({
      store,
      environments: [{ name: 'production', approvals: 1 }],
      // the same person shows up under different display names on different clients
      identify: (request) => request.headers.get('x-display'),
      subject: (request) => request.headers.get('x-sub'),
      authorize: () => true,
    });
    const as = (display: string, sub: string, path: string, body: unknown = {}) =>
      api.handle(new Request(`${BASE}${path}`, { method: 'POST', headers: { 'x-display': display, 'x-sub': sub }, body: JSON.stringify(body) }));

    await as('alice@corp', 'okta|00u1', '/environments/production/promote');
    const pending = await store.pending!('production');

    expect((await as('alice', 'okta|00u1', '/environments/production/approve', { id: pending!.id, requestedAt: pending!.requestedAt }))!.status).toBe(403);
    expect((await as('bob@corp', 'okta|00u2', '/environments/production/approve', { id: pending!.id, requestedAt: pending!.requestedAt }))!.status).toBe(200);
  });

  it('serializes promotions, so two at once cannot both become the pending one', async () => {
    const { call, store } = await pipeline();
    await call('/environments/staging/promote', 'ada', 'promote');

    const results = await Promise.all([
      call('/environments/production/promote', 'ada', 'promote'),
      call('/environments/production/promote', 'grace', 'promote'),
    ]);

    expect(results.map((response) => response!.status).sort()).toEqual([202, 409]);
    expect((await store.pending!('production'))!.requestedBy).toBe(results[0]!.status === 202 ? 'ada' : 'grace');
  });

  it('checks a promotion by per-tag ownership, like a pin', async () => {
    const mine = await createSnapshot({ manifests: [{ ...v1[0]!, tags: ['finance'] }, { id: 'reviews', endpoint: 'https://r.internal', tags: ['react'] }] });
    const theirs = await createSnapshot({ manifests: [{ ...v1[0]!, tags: ['finance'] }, { id: 'reviews', endpoint: 'https://r.internal', tags: ['react'], title: 'changed' }] });
    const store = memorySnapshotStore([mine, theirs]);
    await store.setRef!('staging', mine.id);
    const api = createRegistryApi({
      store,
      environments: [{ name: 'staging' }],
      authorize: () => true,
      owns: () => ['finance'],
    });

    const response = await api.handle(new Request(`${BASE}/environments/staging/promote`, { method: 'POST', body: JSON.stringify({ id: theirs.id }) }));

    expect(response!.status).toBe(403);
    expect(await store.ref!('staging')).toBe(mine.id);
  });
});
