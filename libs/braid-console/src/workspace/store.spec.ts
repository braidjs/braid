// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createGateway, memoryPreferenceBackend, isPreferenceKey } from '@braidlabs/gateway';
import { isStoreKey, keySegment, localStorageStore, memoryStore, serverStore, type PreferenceStore } from './store.js';

/** A `Storage` over a Map, as `localStorage` behaves. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
  };
}

/** A server store talking to a real gateway, as the signed-in `user`. */
function gatewayStore(backend = memoryPreferenceBackend(), user = 'alice'): PreferenceStore {
  const gateway = createGateway({
    registry: [{ id: 'billing', endpoint: 'https://billing.internal' }],
    mode: 'production',
    preferences: { backend },
    principal: (request) => (request.headers.get('x-user') ? { subject: request.headers.get('x-user')! } : undefined),
  });
  return serverStore({
    fetch: async (input, init) => {
      const request = new Request(new URL(String(input), 'https://portal.example'), init);
      request.headers.set('x-user', user);
      request.headers.set('sec-fetch-site', 'same-origin');
      return (await gateway.handle(request)) ?? new Response('not the gateway', { status: 404 });
    },
  });
}

const stores: [string, () => PreferenceStore][] = [
  ['memoryStore', () => memoryStore()],
  ['localStorageStore', () => localStorageStore({ storage: fakeStorage() })],
  ['serverStore', () => gatewayStore()],
];

describe.each(stores)('%s, as a PreferenceStore', (_name, create) => {
  it('stores, reads and deletes JSON values', async () => {
    const store = create();
    expect(await store.get('apps/billing/theme')).toBeUndefined();
    await store.set('apps/billing/theme', { dark: true, size: 3, tags: ['a'] });
    expect(await store.get('apps/billing/theme')).toEqual({ dark: true, size: 3, tags: ['a'] });
    await store.delete('apps/billing/theme');
    expect(await store.get('apps/billing/theme')).toBeUndefined();
  });

  it('keeps a stored null, false and zero apart from a missing key', async () => {
    const store = create();
    await store.set('a', null);
    await store.set('b', false);
    await store.set('c', 0);
    expect([await store.get('a'), await store.get('b'), await store.get('c')]).toEqual([null, false, 0]);
  });

  it('lists keys under a prefix, sorted', async () => {
    const store = create();
    await store.set('layouts/b', 1);
    await store.set('layouts/a', 1);
    await store.set('apps/billing/x', 1);
    expect(await store.list('layouts/')).toEqual(['layouts/a', 'layouts/b']);
    expect(await store.list('')).toEqual(['apps/billing/x', 'layouts/a', 'layouts/b']);
  });

  it('hands back copies, not the object it was given', async () => {
    const store = create();
    const value = { n: 1 };
    await store.set('k', value);
    value.n = 2;
    expect(await store.get('k')).toEqual({ n: 1 });
  });

  it('refuses a malformed key and a value that is not JSON', async () => {
    const store = create();
    await expect(store.set('../x', 1)).rejects.toThrow(TypeError);
    await expect(store.get('a b')).rejects.toThrow(TypeError);
    await expect(store.set('k', undefined)).rejects.toThrow(TypeError);
  });

  it('round-trips a key built from arbitrary names', async () => {
    const store = create();
    const key = `layouts/${keySegment("Jeff's desk (2) / 100%")}`;
    await store.set(key, 'ok');
    expect(await store.get(key)).toBe('ok');
    expect(await store.list('layouts/')).toEqual([key]);
  });
});

describe('keySegment()', () => {
  it('makes a key the client and the gateway both accept from any string', () => {
    for (const name of ['', '.', '..', 'a/b', "it's (fine)!*", '100%', 'ünïcödé', ' ', 'fdc3.instrument']) {
      const key = `layouts/${keySegment(name)}`;
      expect(isStoreKey(key), name).toBe(true);
      expect(isPreferenceKey(key), name).toBe(true);
    }
  });
});

describe('localStorageStore()', () => {
  it('keeps its entries under a prefix, apart from the page', async () => {
    const storage = fakeStorage();
    storage.setItem('unrelated', 'x');
    storage.setItem('braid.workspace/broken', '{');
    const store = localStorageStore({ storage });
    await store.set('k', 1);
    expect(storage.getItem('braid.workspace/k')).toBe('1');
    expect(await store.list('')).toEqual(['broken', 'k']);
    expect(await store.get('broken')).toBeUndefined();
  });

  it('falls back to memory where localStorage is unavailable', async () => {
    const store = localStorageStore();
    await store.set('k', 1);
    expect(await store.get('k')).toBe(1);
  });
});

describe('serverStore()', () => {
  it("keeps one user's entries from another's", async () => {
    const backend = memoryPreferenceBackend();
    await gatewayStore(backend, 'alice').set('apps/billing/theme', 'dark');
    expect(await gatewayStore(backend, 'bob').get('apps/billing/theme')).toBeUndefined();
    expect(await gatewayStore(backend, 'alice').get('apps/billing/theme')).toBe('dark');
  });

  it('rejects with the status when the gateway refuses', async () => {
    const store = serverStore({ fetch: async () => new Response('{}', { status: 401 }) });
    await expect(store.get('k')).rejects.toThrow('401');
    await expect(store.set('k', 1)).rejects.toThrow('401');
  });
});
