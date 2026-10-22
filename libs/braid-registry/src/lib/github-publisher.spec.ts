import { describe, expect, it, vi } from 'vitest';
import type { FragmentManifest } from '@braidlabs/gateway';
import { createRegistryApi } from './api.js';
import { memorySnapshotStore } from './store.js';
import { createSnapshot, serializeSnapshot } from './snapshot.js';
import { githubPublisher } from './github-publisher.js';
import type { AuditEvent } from './audit.js';

const BASE = 'https://ops.example/__braid/registry-api';
const manifests: FragmentManifest[] = [{ id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] }];

/** A recorded GitHub: answers each REST call the publisher makes, and keeps what it was sent. */
function fakeGitHub(options: { headFileExists?: boolean } = {}) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: pathname, ...(body ? { body } : {}) });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

    if (method === 'GET' && pathname.endsWith('/git/ref/heads/main')) return json({ object: { sha: 'base-sha' } });
    if (method === 'POST' && pathname.endsWith('/git/refs')) return json({}, 201);
    if (method === 'GET' && pathname.includes('/contents/')) {
      return options.headFileExists ? json({ sha: 'head-file-sha' }) : json({ message: 'Not Found' }, 404);
    }
    if (method === 'PUT' && pathname.includes('/contents/')) return json({}, 201);
    if (method === 'POST' && pathname.endsWith('/pulls')) return json({ html_url: 'https://github.com/acme/registry/pull/7', number: 7 }, 201);
    return json({ message: 'unexpected' }, 500);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function gitOpsApi(github = fakeGitHub()) {
  const store = memorySnapshotStore();
  const events: AuditEvent[] = [];
  const api = createRegistryApi({
    store,
    authorize: () => true,
    identify: () => 'ada@example.com',
    publisher: githubPublisher({ owner: 'acme', repo: 'registry', token: 'ghp_test', directory: 'braid/registry', fetch: github.fetch }),
    audit: (event) => void events.push(event),
  });
  const publish = (body: unknown) => api.handle(new Request(`${BASE}/snapshots`, { method: 'POST', body: JSON.stringify(body) }));
  return { api, store, github, events, publish };
}

describe('GitOps publishing', () => {
  it('opens a pull request instead of publishing, leaving the store and HEAD alone', async () => {
    const { publish, store, events } = gitOpsApi();

    const response = await publish({ manifests });
    const body = await response!.json();

    expect(response!.status).toBe(202);
    expect(body.pullRequest).toEqual({ url: 'https://github.com/acme/registry/pull/7', number: 7 });
    expect(await store.head?.()).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ action: 'publish', outcome: 'success', status: 202, pullRequest: 'https://github.com/acme/registry/pull/7' })]);
  });

  it('writes the snapshot in the file store layout on a branch, then opens the pull request', async () => {
    const { publish, github } = gitOpsApi();

    const response = await publish({ manifests });
    const { snapshot } = await response!.json();
    const expected = await createSnapshot({ manifests, labels: { publishedBy: 'ada@example.com' } });

    const steps = github.calls.map((call) => `${call.method} ${call.path.replace('/repos/acme/registry', '')}`);
    expect(steps).toEqual([
      'GET /git/ref/heads/main',
      'POST /git/refs',
      `PUT /contents/braid/registry/${snapshot.id}.json`,
      'GET /contents/braid/registry/HEAD',
      'PUT /contents/braid/registry/HEAD',
      'POST /pulls',
    ]);

    const branch = (github.calls[1]!.body as { ref: string }).ref.replace('refs/heads/', '');
    const file = github.calls[2]!.body as { content: string; branch: string };
    expect(file.branch).toBe(branch);
    // byte-equal to what the file store would hold, so merging the PR is a publish
    expect(Buffer.from(file.content, 'base64').toString('utf8')).toBe(serializeSnapshot({ ...expected, createdAt: snapshot.createdAt }));
    expect(Buffer.from((github.calls[4]!.body as { content: string }).content, 'base64').toString('utf8')).toBe(`${snapshot.id}\n`);

    const pull = github.calls[5]!.body as { head: string; base: string; title: string; body: string };
    expect(pull).toMatchObject({ head: branch, base: 'main' });
    expect(pull.body).toContain('ada@example.com');
  });

  it('updates an existing HEAD file in place', async () => {
    const github = fakeGitHub({ headFileExists: true });
    const { publish } = gitOpsApi(github);

    await publish({ manifests });

    expect((github.calls.find((call) => call.method === 'PUT' && call.path.endsWith('/HEAD'))!.body as { sha?: string }).sha).toBe('head-file-sha');
  });

  it('leaves HEAD out of a candidate', async () => {
    const { publish, github } = gitOpsApi();

    await publish({ manifests, pin: false });

    expect(github.calls.some((call) => call.path.endsWith('/HEAD'))).toBe(false);
  });

  it('refuses an invalid registry before talking to GitHub at all', async () => {
    const { publish, github } = gitOpsApi();

    const response = await publish({ manifests: [{ id: 'billing', endpoint: '/relative' }] });

    expect(response!.status).toBe(422);
    expect(github.calls).toEqual([]);
  });

  it('reports a GitHub failure as a server error, without the token', async () => {
    const failing = vi.fn(async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }));
    const api = createRegistryApi({
      store: memorySnapshotStore(),
      authorize: () => true,
      publisher: githubPublisher({ owner: 'acme', repo: 'registry', token: 'ghp_secret', fetch: failing as unknown as typeof fetch }),
    });

    const response = await api.handle(new Request(`${BASE}/snapshots`, { method: 'POST', body: JSON.stringify({ manifests }) }));
    const text = await response!.text();

    expect(response!.status).toBe(502);
    expect(text).toContain('GitHub');
    expect(text).not.toContain('ghp_secret');
  });
});
