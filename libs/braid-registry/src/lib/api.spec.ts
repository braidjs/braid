import { describe, expect, it, vi } from 'vitest';
import type { FragmentManifest } from '@braidlabs/gateway';
import { createRegistryApi } from './api.js';
import { memorySnapshotStore } from './store.js';
import { createSnapshot } from './snapshot.js';
import type { ShellManifest } from './shell.js';

const BASE = 'https://ops.example/__braid/registry-api';
const manifests: FragmentManifest[] = [{ id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] }];

const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, { method: 'POST', body: JSON.stringify(body) });

const allow = () => true;

describe('registry write API', () => {
  it('ignores requests outside its base path', async () => {
    const api = createRegistryApi({ store: memorySnapshotStore(), authorize: allow });

    expect(await api.handle(new Request('https://ops.example/anything'))).toBeNull();
  });

  describe('authorization', () => {
    it('refuses writes when no authorize hook is configured', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore() });

      const response = await api.handle(post('/snapshots', { manifests }));

      expect(response?.status).toBe(403);
      expect((await response!.json()).error).toMatch(/no `authorize` hook/);
    });

    it('still allows reads without one, matching the registry’s public-by-default posture', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore() });

      expect((await api.handle(new Request(`${BASE}/snapshots`)))?.status).toBe(200);
    });

    it('refuses when the hook says no', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: () => false });

      expect((await api.handle(post('/snapshots', { manifests })))?.status).toBe(403);
    });

    it('tells the hook which action is being attempted', async () => {
      const authorize = vi.fn(() => true);
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize });

      await api.handle(new Request(`${BASE}/snapshots`));
      await api.handle(post('/snapshots', { manifests }));

      expect(authorize.mock.calls.map((call) => (call as unknown as [Request, string])[1])).toEqual([
        'read',
        'publish',
        'pin',
      ]);
    });
  });

  describe('publish', () => {
    it('mints, stores, and pins', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow });

      const response = await api.handle(post('/snapshots', { manifests }));
      const result = await response?.json();

      expect(response?.status).toBe(201);
      expect(result.snapshot.id).toMatch(/^reg_/);
      expect(result.pinned).toBe(true);
      expect(await store.head?.()).toBe(result.snapshot.id);
    });

    it('can publish without pinning, so a snapshot can be prepared before it is used', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow });

      const result = await (await api.handle(post('/snapshots', { manifests, pin: false })))?.json();

      expect(result.pinned).toBe(false);
      expect(await store.head?.()).toBeNull();
    });

    it('refuses a registry with errors and writes nothing', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow });

      const response = await api.handle(post('/snapshots', { manifests: [{ id: 'x', endpoint: '/relative' }] }));

      expect(response?.status).toBe(422);
      expect((await response!.json()).findings[0].code).toBe('invalid-endpoint');
      expect(await store.list()).toEqual([]);
    });

    it('validates server-side even when a client did not', async () => {
      // the console validates as you type because that is good to use, not because it is trusted
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: allow });

      const response = await api.handle(
        post('/snapshots', { manifests: [{ id: 'a/b', endpoint: 'https://x.internal' }] }),
      );

      expect(response?.status).toBe(422);
    });

    it('returns warnings alongside a successful publish', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: allow });

      const result = await (
        await api.handle(
          post('/snapshots', {
            manifests: [
              { id: 'a', endpoint: 'https://a.internal', pierce: ['/*'] },
              { id: 'b', endpoint: 'https://b.internal', pierce: ['/billing/*'] },
            ],
          }),
        )
      )?.json();

      expect(result.findings[0].code).toBe('pierce-overlap');
      expect(result.snapshot.id).toMatch(/^reg_/);
    });

    it('reports what the new snapshot changes about the pinned one', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow });
      await api.handle(post('/snapshots', { manifests }));

      const result = await (
        await api.handle(
          post('/snapshots', { manifests: [...manifests, { id: 'reviews', endpoint: 'https://r.internal' }] }),
        )
      )?.json();

      expect(result.diff.added.map((m: FragmentManifest) => m.id)).toEqual(['reviews']);
    });

    it('rejects a body that is not a manifest list', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: allow });

      expect((await api.handle(post('/snapshots', { nope: true })))?.status).toBe(400);
    });

    it('merges descriptors when configured to probe', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ title: 'Billing from the app' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const store = memorySnapshotStore();
      const api = createRegistryApi({
        store,
        authorize: allow,
        fetchDescriptors: true,
        fetch: fetchMock as unknown as typeof fetch,
      });

      const result = await (await api.handle(post('/snapshots', { manifests })))?.json();
      const snapshot = await store.get(result.snapshot.id);

      expect(snapshot?.manifests[0]?.title).toBe('Billing from the app');
      expect(result.descriptorNotes[0]).toMatchObject({ kind: 'applied', field: 'title' });
    });

    it('does not probe unless asked', async () => {
      const fetchMock = vi.fn();
      const api = createRegistryApi({
        store: memorySnapshotStore(),
        authorize: allow,
        fetch: fetchMock as unknown as typeof fetch,
      });

      await api.handle(post('/snapshots', { manifests }));

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('read and pin', () => {
    it('lists snapshots with the current head', async () => {
      const snapshot = await createSnapshot({ manifests });
      const store = memorySnapshotStore([snapshot]);
      await store.setHead?.(snapshot.id);
      const api = createRegistryApi({ store, authorize: allow });

      const body = await (await api.handle(new Request(`${BASE}/snapshots`)))?.json();

      expect(body.items[0].id).toBe(snapshot.id);
      expect(body.head).toBe(snapshot.id);
    });

    it('pages history with a next cursor, so nothing older than one page is out of reach', async () => {
      const minted = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          createSnapshot({ manifests: [{ id: `f${i}`, endpoint: 'https://f.internal' }], createdAt: `2026-01-0${i + 1}T00:00:00.000Z` }),
        ),
      );
      const api = createRegistryApi({ store: memorySnapshotStore(minted), authorize: allow });
      const page = async (query: string) => (await api.handle(new Request(`${BASE}/snapshots${query}`)))!.json();

      const first = await page('?limit=2');
      const second = await page(`?limit=2&before=${encodeURIComponent(first.next)}`);
      const third = await page(`?limit=2&before=${encodeURIComponent(second.next)}`);

      expect([...first.items, ...second.items, ...third.items].map((ref: { id: string }) => ref.id)).toEqual(
        [...minted].reverse().map((snapshot) => snapshot.id),
      );
      expect(third.next).toBeNull();
      expect((await api.handle(new Request(`${BASE}/snapshots?before=nonsense`)))!.status).toBe(400);
    });

    it('ends the listing rather than looping when a custom store ignores before', async () => {
      const minted = await Promise.all(
        [1, 2, 3].map((i) => createSnapshot({ manifests: [{ id: `f${i}`, endpoint: 'https://f.internal' }], createdAt: `2026-01-0${i}T00:00:00.000Z` })),
      );
      const inner = memorySnapshotStore(minted);
      const legacy = { ...inner, list: ({ limit }: { limit?: number } = {}) => inner.list(limit === undefined ? {} : { limit }) };
      const api = createRegistryApi({ store: legacy, authorize: allow });

      const first = await (await api.handle(new Request(`${BASE}/snapshots?limit=2`)))!.json();
      const second = await (await api.handle(new Request(`${BASE}/snapshots?limit=2&before=${encodeURIComponent(first.next)}`)))!.json();

      expect(second.items).toEqual([]);
      expect(second.next).toBeNull();
    });

    it('serves a snapshot by id and 404s an unknown one', async () => {
      const snapshot = await createSnapshot({ manifests });
      const api = createRegistryApi({ store: memorySnapshotStore([snapshot]), authorize: allow });

      expect((await api.handle(new Request(`${BASE}/snapshots/${snapshot.id}`)))?.status).toBe(200);
      expect((await api.handle(new Request(`${BASE}/snapshots/reg_missing`)))?.status).toBe(404);
    });

    it('re-pins to an existing snapshot', async () => {
      const first = await createSnapshot({ manifests });
      const second = await createSnapshot({ manifests: [...manifests, { id: 'r', endpoint: 'https://r.internal' }] });
      const store = memorySnapshotStore([first, second]);
      const api = createRegistryApi({ store, authorize: allow });

      // rollback is a pointer move: no inverse migration, no undo log
      expect((await api.handle(post('/head', { id: first.id })))?.status).toBe(200);
      expect(await store.head?.()).toBe(first.id);
    });

    it('refuses to pin a snapshot that is not stored', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: allow });

      const response = await api.handle(post('/head', { id: 'reg_nope' }));

      expect(response?.status).toBe(404);
      expect((await response!.json()).error).toMatch(/cannot pin what is not stored/);
    });
  });

  describe('hardening', () => {
    it('answers malformed JSON with 400, not 500', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: allow });
      const malformed = (path: string) => new Request(`${BASE}${path}`, { method: 'POST', body: '{"manifests": [' });

      for (const path of ['/snapshots', '/head']) {
        const response = await api.handle(malformed(path));
        expect(response?.status).toBe(400);
        expect((await response!.json()).error).toMatch(/not valid JSON/);
      }
    });

    it('refuses a body over maxBodyBytes with 413, before parsing it', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow, maxBodyBytes: 1024 });
      const big = JSON.stringify({ manifests: [{ ...manifests[0], description: 'x'.repeat(2048) }] });

      // declared up front…
      expect((await api.handle(post('/snapshots', JSON.parse(big))))!.status).toBe(413);
      // …and counted while streaming, when nothing was declared
      const chunked = new Request(`${BASE}/snapshots`, { method: 'POST', body: new Blob([big]).stream(), duplex: 'half' } as RequestInit);
      expect(chunked.headers.get('content-length')).toBeNull();
      expect((await api.handle(chunked))!.status).toBe(413);

      expect(await store.list()).toEqual([]);
      expect((await api.handle(post('/snapshots', { manifests })))!.status).toBe(201);
    });

    it('requires JSON from a browser, so a form or text/plain POST cannot skip the CORS preflight', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: allow });
      const fromBrowser = (type: string) =>
        new Request(`${BASE}/snapshots`, {
          method: 'POST',
          headers: { 'sec-fetch-site': 'same-site', 'content-type': type },
          body: JSON.stringify({ manifests }),
        });

      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
        expect((await api.handle(fromBrowser(type)))!.status).toBe(415);
      }
      expect((await api.handle(fromBrowser('application/json; charset=utf-8')))!.status).toBe(201);
      // a pipeline, which sends no browser headers, is not a browser
      expect((await api.handle(post('/snapshots', { manifests })))!.status).toBe(201);
    });

    it('refuses an endpoint outside endpointOrigins, which the gateway would open to the internet', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow, endpointOrigins: ['https://billing.internal'] });

      const refused = await api.handle(post('/snapshots', { manifests: [...manifests, { id: 'admin', endpoint: 'http://internal-admin:8080/' }] }));

      expect(refused!.status).toBe(422);
      expect((await refused!.json()).findings).toEqual([
        expect.objectContaining({ code: 'endpoint-not-allowed', fragmentIds: ['admin'], severity: 'error' }),
      ]);
      expect(await store.list()).toEqual([]);
      expect((await api.handle(post('/snapshots', { manifests })))!.status).toBe(201);
    });

    it('refuses a misconfigured endpointOrigins at startup', () => {
      for (const origin of ['billing.internal', 'https://billing.internal/path']) {
        expect(() => createRegistryApi({ store: memorySnapshotStore(), authorize: allow, endpointOrigins: [origin] })).toThrow(/must be an origin/);
      }
    });

    it('refuses a publish whose base is stale, and says where HEAD is', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow });
      const first = await (await api.handle(post('/snapshots', { manifests, baseId: null })))!.json();

      const stale = await api.handle(post('/snapshots', { manifests: [...manifests, { id: 'r', endpoint: 'https://r.internal' }], baseId: null }));

      expect(stale?.status).toBe(409);
      expect((await stale!.json()).head).toBe(first.snapshot.id);
      expect(await store.head?.()).toBe(first.snapshot.id);
    });

    it('accepts a publish whose base is current', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow });
      const first = await (await api.handle(post('/snapshots', { manifests, baseId: null })))!.json();

      const next = await api.handle(post('/snapshots', { manifests: [...manifests, { id: 'r', endpoint: 'https://r.internal' }], baseId: first.snapshot.id }));

      expect(next?.status).toBe(201);
    });

    it('checks pin permission when a publish pins, and writes nothing when refused', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: (_request, action) => action !== 'pin' });

      const pinned = await api.handle(post('/snapshots', { manifests }));
      expect(pinned?.status).toBe(403);
      expect(await store.list({ limit: 10 })).toEqual([]);
      expect(await store.head?.()).toBeNull();

      const candidate = await api.handle(post('/snapshots', { manifests, pin: false }));
      expect(candidate?.status).toBe(201);
      expect(await store.head?.()).toBeNull();
    });

    it('passes a Response from authorize through unchanged', async () => {
      const challenge = new Response('{}', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: () => challenge });

      const response = await api.handle(new Request(`${BASE}/head`));

      expect(response?.status).toBe(401);
      expect(response?.headers.get('www-authenticate')).toBe('Bearer');
    });
  });

  describe('identity', () => {
    it('records the verified actor as publishedBy, over whatever the client claimed', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow, identify: () => 'dana@example.com' });

      const result = await (await api.handle(post('/snapshots', { manifests, labels: { publishedBy: 'someone-else', note: 'x' } })))!.json();
      const stored = await store.get(result.snapshot.id);

      expect(stored?.labels).toEqual({ publishedBy: 'dana@example.com', note: 'x' });
    });

    it('drops a claimed publishedBy when the caller cannot be identified', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow, identify: () => null });

      const result = await (await api.handle(post('/snapshots', { manifests, labels: { publishedBy: 'forged' } })))!.json();

      expect((await store.get(result.snapshot.id))?.labels).toBeUndefined();
    });

    it('keeps client labels as they are without an identify hook', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow });

      const result = await (await api.handle(post('/snapshots', { manifests, labels: { publishedBy: 'ci' } })))!.json();

      expect((await store.get(result.snapshot.id))?.labels).toEqual({ publishedBy: 'ci' });
    });

    it('reports the caller’s own permissions and identity', async () => {
      const api = createRegistryApi({
        store: memorySnapshotStore(),
        authorize: (_request, action) => action !== 'pin',
        identify: () => 'dana@example.com',
      });

      const body = await (await api.handle(new Request(`${BASE}/permissions`)))!.json();

      expect(body).toEqual({ read: true, publish: true, pin: false, actor: 'dana@example.com', tags: null });
    });

    it('reports read-only permissions when no authorize hook is configured', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore() });

      const body = await (await api.handle(new Request(`${BASE}/permissions`)))!.json();

      expect(body).toEqual({ read: true, publish: false, pin: false, actor: null, tags: null });
    });
  });

  describe('shells', () => {
    const storefront: ShellManifest = {
      id: 'storefront',
      framework: 'react',
      routes: [{ path: '/billing/*', layout: { areas: 'header\nmain' }, slots: { main: 'billing' } }],
    };

    it('publishes shells and serves them from head and by id', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: allow });

      const result = await (await api.handle(post('/snapshots', { manifests, shells: [storefront] })))!.json();
      const head = await (await api.handle(new Request(`${BASE}/head`)))!.json();
      const byId = await (await api.handle(new Request(`${BASE}/snapshots/${result.snapshot.id}`)))!.json();

      expect(head.snapshot.shells).toEqual([storefront]);
      expect(byId.shells).toEqual([storefront]);
    });

    it('carries HEAD’s shells forward when a publish omits them, and clears them on []', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow });
      await api.handle(post('/snapshots', { manifests, shells: [storefront] }));

      const carried = await (await api.handle(post('/snapshots', { manifests: [...manifests, { id: 'r', endpoint: 'https://r.internal' }] })))!.json();
      expect((await store.get(carried.snapshot.id))?.shells).toEqual([storefront]);

      const cleared = await (await api.handle(post('/snapshots', { manifests, shells: [] })))!.json();
      expect((await store.get(cleared.snapshot.id))?.shells).toBeUndefined();
    });

    it('refuses invalid shells with their findings', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: allow });

      const response = await api.handle(post('/snapshots', { manifests, shells: [{ ...storefront, head: { scripts: [{ src: 'javascript:alert(1)' }] } }] }));

      expect(response?.status).toBe(422);
      expect((await response!.json()).findings.map((f: { code: string }) => f.code)).toEqual(['unsafe-shell-url']);
    });

    it('refuses to delete a fragment a carried-forward shell still slots', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow });
      await api.handle(post('/snapshots', { manifests, shells: [storefront] }));

      const response = await api.handle(post('/snapshots', { manifests: [{ id: 'other', endpoint: 'https://o.internal' }] }));
      const body = await response!.json();

      expect(response?.status).toBe(422);
      expect(body.findings[0]).toMatchObject({ code: 'slot-unknown-fragment', shellIds: ['storefront'], fragmentIds: ['billing'] });
    });

    it('rejects shells that are not an array', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: allow });

      expect((await api.handle(post('/snapshots', { manifests, shells: {} })))?.status).toBe(400);
    });
  });

  describe('ordering and cross-site writes', () => {
    it('refuses an unauthorized publish before reading its body', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: (_request, action) => action === 'read' });

      const response = await api.handle(new Request(`${BASE}/snapshots`, { method: 'POST', body: '{bad' }));

      expect(response?.status).toBe(403);
    });

    it('refuses a stale publish without probing or storing anything', async () => {
      const store = memorySnapshotStore();
      const probe = vi.fn(async () => new Response('{}', { status: 404 }));
      const api = createRegistryApi({ store, authorize: allow, fetchDescriptors: true, fetch: probe as unknown as typeof fetch });

      const response = await api.handle(post('/snapshots', { manifests, baseId: 'reg_stale' }));

      expect(response?.status).toBe(409);
      expect(probe).not.toHaveBeenCalled();
      expect(await store.list({ limit: 10 })).toEqual([]);
    });

    it('refuses to pin when HEAD moved while the publish was in flight', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, authorize: allow });
      const first = await (await api.handle(post('/snapshots', { manifests })))!.json();
      // Someone else pins between this publish's first check and its write.
      const other = await createSnapshot({ manifests: [{ id: 'other', endpoint: 'https://o.internal' }] });
      await store.put(other);
      const head = store.head!.bind(store);
      let calls = 0;
      store.head = async () => (++calls === 1 ? head() : other.id);

      const response = await api.handle(post('/snapshots', { manifests: [...manifests, { id: 'r', endpoint: 'https://r.internal' }], baseId: first.snapshot.id }));

      expect(response?.status).toBe(409);
      expect((await response!.json()).head).toBe(other.id);
    });

    it('refuses a write a browser marks as cross-site', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore(), authorize: allow });
      const forged = new Request(`${BASE}/snapshots`, { method: 'POST', body: JSON.stringify({ manifests }), headers: { 'sec-fetch-site': 'cross-site' } });

      expect((await api.handle(forged))?.status).toBe(403);
      expect((await api.handle(post('/snapshots', { manifests })))?.status).toBe(201);
    });
  });
});
