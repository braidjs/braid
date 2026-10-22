import { afterEach, describe, expect, it, vi } from 'vitest';
import { Registry } from './registry.js';
import type { FragmentManifest } from './registry.js';
import { createGateway } from './gateway.js';

/**
 * A registry that can change under a running gateway. The snapshot model made a re-pin a deploy;
 * a gateway that follows HEAD now picks up a re-pin by reloading its source, and the swap has to
 * be all-or-nothing — a request must never see one snapshot's manifests with another's routes.
 */
describe('Registry.refresh()', () => {
  const a: FragmentManifest[] = [{ id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] }];
  const b: FragmentManifest[] = [{ id: 'orders', endpoint: 'https://orders.internal', pierce: ['/orders/*'] }];

  it('replaces manifests and pierce routes together', async () => {
    let current = a;
    const registry = new Registry(async () => current);
    expect((await registry.matchPierceRoutes('/billing/1')).map((m) => m.id)).toEqual(['billing']);

    current = b;
    const result = await registry.refresh();

    expect(result).toMatchObject({ changed: true, removed: ['billing'] });
    expect(await registry.matchPierceRoutes('/billing/1')).toEqual([]);
    expect((await registry.matchPierceRoutes('/orders/1')).map((m) => m.id)).toEqual(['orders']);
    expect(await registry.getFragment('billing')).toBeUndefined();
  });

  it('keeps serving the previous registry when the source fails, and says why', async () => {
    let fail = false;
    const registry = new Registry(async () => {
      if (fail) throw new Error('store unreachable');
      return a;
    });
    await registry.listFragments();

    fail = true;
    await expect(registry.refresh()).rejects.toThrow('store unreachable');
    expect((await registry.listFragments()).map((m) => m.id)).toEqual(['billing']);
  });

  it('keeps serving the previous registry when the new one does not compile', async () => {
    let current: FragmentManifest[] = a;
    const registry = new Registry(async () => current);
    await registry.listFragments();

    current = [{ id: 'bad/id', endpoint: 'https://x.internal' }];
    await expect(registry.refresh()).rejects.toThrow(/invalid/);
    expect((await registry.listFragments()).map((m) => m.id)).toEqual(['billing']);
  });

  it('does nothing when the source returns the same manifests', async () => {
    const registry = new Registry(async () => a);
    await registry.listFragments();

    expect(await registry.refresh()).toMatchObject({ changed: false });
  });

  it('reports fragments whose endpoint changed, so their circuit can be reset', async () => {
    let current = a;
    const registry = new Registry(async () => current);
    await registry.listFragments();

    current = [{ ...a[0], endpoint: 'https://billing-v2.internal' }];
    expect(await registry.refresh()).toMatchObject({ changed: true, removed: [], endpointChanged: ['billing'] });
  });

  it('loads a cold registry once however many requests arrive together', async () => {
    const source = vi.fn(async () => a);
    const registry = new Registry(source);

    await Promise.all([registry.listFragments(), registry.getFragment('billing'), registry.matchPierceRoutes('/billing/1')]);

    expect(source).toHaveBeenCalledTimes(1);
  });

  it('shares one refresh between callers that ask at once', async () => {
    let current = a;
    const source = vi.fn(async () => current);
    const registry = new Registry(source);
    await registry.listFragments();
    current = b;

    await Promise.all([registry.refresh(), registry.refresh()]);

    expect(source).toHaveBeenCalledTimes(2);
  });
});

describe('gateway registryRefreshMs', () => {
  afterEach(() => vi.useRealTimers());

  const realmFor = (gateway: ReturnType<typeof createGateway>, id: string) =>
    gateway.handle(new Request(`https://shell.example/__braid/realm/${id}/`));

  it('follows its source on an interval, with no restart', async () => {
    vi.useFakeTimers();
    let current: FragmentManifest[] = [{ id: 'billing', endpoint: 'https://billing.internal' }];
    const gateway = createGateway({ mode: 'production', registry: async () => current, registryRefreshMs: 1000 });

    expect((await realmFor(gateway, 'orders'))!.status).toBe(404);
    current = [{ id: 'orders', endpoint: 'https://orders.internal' }];
    await vi.advanceTimersByTimeAsync(1000);

    expect((await realmFor(gateway, 'orders'))!.status).toBe(200);
    gateway.close();
  });

  it('reports each refresh, and a failed one, as telemetry', async () => {
    vi.useFakeTimers();
    const events: unknown[] = [];
    let fail = false;
    const gateway = createGateway({
      mode: 'production',
      registry: async () => {
        if (fail) throw new Error('store unreachable');
        return [{ id: 'billing', endpoint: 'https://billing.internal' }];
      },
      registryRefreshMs: 1000,
      telemetry: { on: (event) => void events.push(event) },
    });
    await realmFor(gateway, 'billing');

    fail = true;
    await vi.advanceTimersByTimeAsync(1000);

    expect(events).toContainEqual(expect.objectContaining({ kind: 'registry', outcome: 'failed', error: 'store unreachable' }));
    // and the old registry still answers
    expect((await realmFor(gateway, 'billing'))!.status).toBe(200);
    gateway.close();
  });

  it('can be told to refresh now', async () => {
    let current: FragmentManifest[] = [{ id: 'billing', endpoint: 'https://billing.internal' }];
    const gateway = createGateway({ mode: 'production', registry: async () => current });
    await realmFor(gateway, 'billing');

    current = [{ id: 'orders', endpoint: 'https://orders.internal' }];
    await gateway.refreshRegistry();

    expect((await realmFor(gateway, 'orders'))!.status).toBe(200);
  });

  it('refuses a refresh interval for an inline registry, which cannot change', () => {
    expect(() =>
      createGateway({ registry: [{ id: 'billing', endpoint: 'https://billing.internal' }], registryRefreshMs: 1000 }),
    ).toThrow(/registryRefreshMs/);
  });
});

describe('realm stub caching', () => {
  it('can be revalidated, and is short-lived enough for a re-pin to reach browsers', async () => {
    const gateway = createGateway({ mode: 'production', registry: [{ id: 'billing', endpoint: 'https://billing.internal' }] });

    const first = (await gateway.handle(new Request('https://shell.example/__braid/realm/billing/')))!;
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[\w-]+"$/);
    expect(first.headers.get('cache-control')).toBe('max-age=300, public, stale-while-revalidate=3600');

    const revalidated = (await gateway.handle(
      new Request('https://shell.example/__braid/realm/billing/', { headers: { 'if-none-match': etag! } }),
    ))!;
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe('');
  });
});
