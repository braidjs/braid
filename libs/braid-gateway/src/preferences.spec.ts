import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGateway } from './gateway.js';
import { isPreferenceKey, memoryPreferenceBackend, type PreferenceBackend, type PreferenceLimits } from './preferences.js';
import { filePreferenceBackend } from './preferences-file.js';

const ORIGIN = 'https://portal.example';
const LIMITS: PreferenceLimits = { maxEntries: 1000, maxTotalBytes: 1024 * 1024 };

/** A gateway whose principal is whoever the `x-user` header names. */
function gateway(
  backend: PreferenceBackend = memoryPreferenceBackend(),
  extra: { maxValueBytes?: number; maxEntries?: number; maxTotalBytes?: number; path?: string } = {},
  principal?: (request: Request) => { subject: string } | undefined,
) {
  return createGateway({
    registry: [{ id: 'billing', endpoint: 'https://billing.internal' }],
    mode: 'production',
    preferences: { backend, ...extra },
    principal:
      principal ??
      ((request) => {
        const user = request.headers.get('x-user');
        return user ? { subject: user } : undefined;
      }),
  });
}

function request(path: string, init: RequestInit & { user?: string } = {}): Request {
  const { user, headers, ...rest } = init;
  return new Request(`${ORIGIN}/__braid/preferences${path}`, {
    ...rest,
    headers: { ...(user ? { 'x-user': user } : {}), ...(headers as Record<string, string>) },
  });
}

const put = (path: string, value: unknown, user = 'alice', headers: Record<string, string> = {}) =>
  request(path, {
    method: 'PUT',
    user,
    body: JSON.stringify(value),
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
  });

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function tempDirectory() {
  const created = await mkdtemp(join(tmpdir(), 'braid-prefs-'));
  directories.push(created);
  return created;
}

describe('isPreferenceKey()', () => {
  it('accepts slash-separated safe segments and nothing else', () => {
    for (const key of ['apps/billing/theme', 'intents/ViewChart/fdc3.instrument', 'layouts/My%20desk', 'a']) {
      expect(isPreferenceKey(key)).toBe(true);
    }
    for (const key of ['', '/a', 'a/', 'a//b', '../a', 'a/./b', 'a b', 'a?b', 'x'.repeat(513), 'a/b/c/d/e/f/g/h/i']) {
      expect(isPreferenceKey(key)).toBe(false);
    }
  });
});

describe('the preferences endpoint', () => {
  it('is not served unless configured', async () => {
    const plain = createGateway({ registry: [{ id: 'billing', endpoint: 'https://billing.internal' }], mode: 'production' });
    expect(await plain.handle(request('/apps/billing/theme', { user: 'alice' }))).toBeNull();
  });

  it('stores, reads, lists and deletes a value', async () => {
    const braid = gateway();
    expect((await braid.handle(put('/apps/billing/theme', { dark: true })))!.status).toBe(204);

    const read = (await braid.handle(request('/apps/billing/theme', { user: 'alice' })))!;
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toBe('private, no-store');
    expect(await read.json()).toEqual({ dark: true });

    const list = (await braid.handle(request('?prefix=apps/', { user: 'alice' })))!;
    expect(await list.json()).toEqual({ keys: ['apps/billing/theme'] });

    const gone = request('/apps/billing/theme', { method: 'DELETE', user: 'alice', headers: { 'sec-fetch-site': 'same-origin' } });
    expect((await braid.handle(gone))!.status).toBe(204);
    expect((await braid.handle(request('/apps/billing/theme', { user: 'alice' })))!.status).toBe(404);
  });

  it('keeps a stored null apart from a missing key', async () => {
    const braid = gateway();
    await braid.handle(put('/k', null));
    const read = (await braid.handle(request('/k', { user: 'alice' })))!;
    expect(read.status).toBe(200);
    expect(await read.json()).toBeNull();
  });

  it('refuses a caller with no subject with 401', async () => {
    const braid = gateway();
    expect((await braid.handle(request('/apps/billing/theme')))!.status).toBe(401);
    expect((await braid.handle(put('/apps/billing/theme', 1, '')))!.status).toBe(401);
  });

  it("never shows one user another's entries", async () => {
    const braid = gateway();
    await braid.handle(put('/apps/billing/theme', 'alice-only'));
    expect((await braid.handle(request('/apps/billing/theme', { user: 'bob' })))!.status).toBe(404);
    expect(await (await braid.handle(request('', { user: 'bob' })))!.json()).toEqual({ keys: [] });
  });

  it('refuses cross-site writes with 403, and a write that is not JSON with 415', async () => {
    const braid = gateway();
    expect((await braid.handle(put('/k', 1, 'alice', { 'sec-fetch-site': 'cross-site' })))!.status).toBe(403);
    expect((await braid.handle(put('/k', 1, 'alice', { 'sec-fetch-site': 'same-site' })))!.status).toBe(403);
    const deleteCrossSite = request('/k', { method: 'DELETE', user: 'alice', headers: { 'sec-fetch-site': 'cross-site' } });
    expect((await braid.handle(deleteCrossSite))!.status).toBe(403);
    // what an HTML form can send
    const form = request('/k', { method: 'PUT', user: 'alice', body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect((await braid.handle(form))!.status).toBe(415);
    expect((await braid.handle(request('/k', { user: 'alice' })))!.status).toBe(404);
  });

  it('refuses an oversized value, and too many entries, with 413', async () => {
    const braid = gateway(memoryPreferenceBackend(), { maxValueBytes: 64, maxEntries: 2 });
    expect((await braid.handle(put('/big', 'x'.repeat(100))))!.status).toBe(413);
    // a body with no declared length is still cut off at the limit
    const streamed = new Request(`${ORIGIN}/__braid/preferences/big`, {
      method: 'PUT',
      headers: { 'x-user': 'alice', 'content-type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify('y'.repeat(100))));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    expect((await braid.handle(streamed))!.status).toBe(413);

    expect((await braid.handle(put('/a', 1)))!.status).toBe(204);
    expect((await braid.handle(put('/b', 2)))!.status).toBe(204);
    expect((await braid.handle(put('/c', 3)))!.status).toBe(413);
    // overwriting an existing key is not a new entry
    expect((await braid.handle(put('/a', 4)))!.status).toBe(204);
  });

  it('holds the entry and byte quotas under concurrent writes, in both backends', async () => {
    for (const backend of [memoryPreferenceBackend(), filePreferenceBackend({ directory: await tempDirectory() })]) {
      const braid = gateway(backend, { maxEntries: 3 });
      const statuses = await Promise.all(Array.from({ length: 10 }, (_, index) => braid.handle(put(`/k${index}`, index)).then((r) => r!.status)));
      expect(statuses.filter((status) => status === 204)).toHaveLength(3);
      expect(statuses.filter((status) => status === 413)).toHaveLength(7);
      expect(await backend.list('alice', '')).toHaveLength(3);
    }
    const small = gateway(memoryPreferenceBackend(), { maxTotalBytes: 100 });
    expect((await small.handle(put('/a', 'x'.repeat(60))))!.status).toBe(204);
    expect((await small.handle(put('/b', 'x'.repeat(60))))!.status).toBe(413);
    // replacing a value counts the new one, not both
    expect((await small.handle(put('/a', 'y'.repeat(60))))!.status).toBe(204);
  });

  it('refuses cross-origin requests by Origin when the browser sends no Sec-Fetch-Site, and cross-site reads', async () => {
    const braid = gateway();
    const fromElsewhere = { 'content-type': 'application/json', origin: 'https://evil.example' };
    const write = request('/k', { method: 'PUT', user: 'alice', body: '1', headers: fromElsewhere });
    expect((await braid.handle(write))!.status).toBe(403);
    const remove = request('/k', { method: 'DELETE', user: 'alice', headers: { origin: 'https://evil.example' } });
    expect((await braid.handle(remove))!.status).toBe(403);
    const sameOrigin = request('/k', { method: 'PUT', user: 'alice', body: '1', headers: { 'content-type': 'application/json', origin: ORIGIN } });
    expect((await braid.handle(sameOrigin))!.status).toBe(204);
    const probe = request('/k', { user: 'alice', headers: { 'sec-fetch-site': 'cross-site' } });
    expect((await braid.handle(probe))!.status).toBe(403);
  });

  it('answers a principal resolver that throws with a generic 500', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const braid = gateway(memoryPreferenceBackend(), {}, () => {
      throw new Error('session store down');
    });
    const response = (await braid.handle(request('/k', { user: 'alice' })))!;
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('session store');
    error.mockRestore();
  });

  it('refuses a path that would claim every request', () => {
    for (const path of ['/', '', 'prefs', '//x']) {
      expect(() => gateway(memoryPreferenceBackend(), { path }), path).toThrow('preferences.path');
    }
    expect(() => gateway(memoryPreferenceBackend(), { path: '/me/prefs/' })).not.toThrow();
  });

  it('refuses malformed keys, prefixes and bodies with 400', async () => {
    const braid = gateway();
    for (const path of ['/a%2Fb', '/a%20b', '/%E0%A4%A', '/a/%2E']) {
      expect((await braid.handle(request(path, { user: 'alice' })))!.status, path).toBe(400);
    }
    // `..` never gets here: the URL parser resolves it (and %2E%2E) before the gateway sees the path
    expect(new URL(`${ORIGIN}/__braid/preferences/a/%2E%2E/b`).pathname).toBe('/__braid/preferences/b');
    expect((await braid.handle(request('?prefix=../', { user: 'alice' })))!.status).toBe(400);
    const notJson = request('/k', { method: 'PUT', user: 'alice', body: '{', headers: { 'content-type': 'application/json' } });
    expect((await braid.handle(notJson))!.status).toBe(400);
  });

  it('refuses other methods with 405', async () => {
    const braid = gateway();
    expect((await braid.handle(request('/k', { method: 'POST', user: 'alice' })))!.status).toBe(405);
    expect((await braid.handle(request('', { method: 'DELETE', user: 'alice' })))!.status).toBe(405);
  });

  it('answers 500, not a stack trace, when the backend fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken: PreferenceBackend = { ...memoryPreferenceBackend(), get: () => Promise.reject(new Error('db down')) };
    const response = (await gateway(broken).handle(request('/k', { user: 'alice' })))!;
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('db down');
    error.mockRestore();
  });
});

describe('filePreferenceBackend()', () => {
  const directory = tempDirectory;

  it('keeps entries across backends on the same directory, per subject', async () => {
    const dir = await directory();
    const first = filePreferenceBackend({ directory: dir });
    await first.set('alice', 'apps/billing/theme', '"dark"', LIMITS);
    await first.set('../../etc/passwd', 'k', '1', LIMITS);

    const second = filePreferenceBackend({ directory: dir });
    expect(await second.get('alice', 'apps/billing/theme')).toBe('"dark"');
    expect(await second.get('bob', 'apps/billing/theme')).toBeUndefined();
    expect(await second.list('alice', 'apps/')).toEqual(['apps/billing/theme']);
    // one hashed file per subject, all inside the directory, readable by the gateway's user only
    const names = await readdir(dir);
    expect(names.every((name) => /^[0-9a-f]{64}\.json$/.test(name))).toBe(true);
    expect((await stat(join(dir, names[0]))).mode & 0o777).toBe(0o600);
  });

  it('loses no key when writes for one subject race', async () => {
    const backend = filePreferenceBackend({ directory: await directory() });
    await Promise.all(Array.from({ length: 20 }, (_, index) => backend.set('alice', `k${index}`, String(index), LIMITS)));
    expect((await backend.list('alice', '')).length).toBe(20);
    await backend.delete('alice', 'k3');
    expect(await backend.get('alice', 'k3')).toBeUndefined();
  });

  it('does not read a key named like an object prototype member', async () => {
    const backend = filePreferenceBackend({ directory: await directory() });
    expect(await backend.get('alice', 'constructor')).toBeUndefined();
  });

  it('serves the gateway endpoint', async () => {
    const braid = gateway(filePreferenceBackend({ directory: await directory() }));
    await braid.handle(put('/layouts/main', { slots: [] }));
    expect(await (await braid.handle(request('/layouts/main', { user: 'alice' })))!.json()).toEqual({ slots: [] });
  });
});
