import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FragmentManifest } from '@braidlabs/gateway';
import { createRegistryApi } from './api.js';
import { memorySnapshotStore } from './store.js';
import { jsonLinesAuditSink, webhookAuditSink, type AuditEvent } from './audit.js';

const BASE = 'https://ops.example/__braid/registry-api';
const manifests: FragmentManifest[] = [{ id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] }];

const request = (method: string, path: string, body?: unknown, actor = 'ada@example.com') =>
  new Request(`${BASE}${path}`, {
    method,
    headers: { 'x-actor': actor },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** An API whose caller is named by a header, standing in for a verified token. */
function auditedApi(authorize: (request: Request, action: string) => boolean = () => true) {
  const events: AuditEvent[] = [];
  const store = memorySnapshotStore();
  const api = createRegistryApi({
    store,
    authorize,
    identify: (request) => request.headers.get('x-actor'),
    audit: (event) => void events.push(event),
  });
  return { api, events, store };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('registry audit events', () => {
  it('records a publish once, with the verified actor and what it changed', async () => {
    const { api, events } = auditedApi();

    const response = await api.handle(request('POST', '/snapshots', { manifests }));
    const { snapshot } = await response!.json();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      version: 1,
      action: 'publish',
      outcome: 'success',
      actor: 'ada@example.com',
      snapshotId: snapshot.id,
      previousId: null,
      pinned: true,
      status: 201,
    });
    expect(new Date(events[0].at).toString()).not.toBe('Invalid Date');
  });

  it('records a pin with the snapshot it moved HEAD from — pins were unattributed before', async () => {
    const { api, events } = auditedApi();
    const first = await (await api.handle(request('POST', '/snapshots', { manifests })))!.json();
    const second = await (
      await api.handle(request('POST', '/snapshots', { manifests: [...manifests, { id: 'orders', endpoint: 'https://o.internal' }] }))
    )!.json();
    events.length = 0;

    await api.handle(request('POST', '/head', { id: first.snapshot.id }, 'grace@example.com'));

    expect(events).toEqual([
      expect.objectContaining({
        action: 'pin',
        outcome: 'success',
        actor: 'grace@example.com',
        snapshotId: first.snapshot.id,
        previousId: second.snapshot.id,
        status: 200,
      }),
    ]);
  });

  it('records a refused write as denied, with its status', async () => {
    const { api, events } = auditedApi((_request, action) => action === 'read');

    await api.handle(request('POST', '/snapshots', { manifests }, 'mallory@example.com'));

    expect(events).toEqual([
      expect.objectContaining({ action: 'publish', outcome: 'denied', actor: 'mallory@example.com', status: 403 }),
    ]);
  });

  it('records a publish the server rejected, and why', async () => {
    const { api, events } = auditedApi();

    await api.handle(request('POST', '/snapshots', { manifests: [{ id: 'billing', endpoint: '/relative' }] }));

    expect(events).toEqual([
      expect.objectContaining({ action: 'publish', outcome: 'rejected', status: 422, reason: expect.stringContaining('errors') }),
    ]);
  });

  it('records a write that failed partway, with what it got as far as', async () => {
    const { api, events, store } = auditedApi();
    vi.spyOn(store, 'setHead').mockRejectedValue(new Error('disk full'));

    const response = await api.handle(request('POST', '/snapshots', { manifests }));

    expect(response!.status).toBe(500);
    expect(events).toEqual([
      expect.objectContaining({ action: 'publish', outcome: 'error', status: 500, reason: 'disk full', pinned: false, snapshotId: expect.any(String) }),
    ]);
  });

  it('records a cross-site write attempt as denied', async () => {
    const { api, events } = auditedApi();

    const response = await api.handle(
      new Request(`${BASE}/head`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site', 'x-actor': 'victim@example.com' }, body: '{}' }),
    );

    expect(response!.status).toBe(403);
    expect(events).toEqual([expect.objectContaining({ action: 'pin', outcome: 'denied', status: 403, actor: 'victim@example.com' })]);
  });

  it('asks who the caller is once per write', async () => {
    const identify = vi.fn((request: Request) => request.headers.get('x-actor'));
    const api = createRegistryApi({ store: memorySnapshotStore(), authorize: () => true, identify, audit: () => undefined });

    await api.handle(request('POST', '/snapshots', { manifests }));

    expect(identify).toHaveBeenCalledTimes(1);
  });

  it('refuses ids that are not short strings, rather than echoing them into the audit trail', async () => {
    const { api, events } = auditedApi();

    expect((await api.handle(request('POST', '/head', { id: { not: 'a string' } })))!.status).toBe(400);
    expect((await api.handle(request('POST', '/head', { id: 'x'.repeat(500) })))!.status).toBe(400);
    expect((await api.handle(request('POST', '/snapshots', { manifests, baseId: ['x'] })))!.status).toBe(400);
    expect(events.every((event) => (event.reason ?? '').length < 300)).toBe(true);
  });

  it('does not audit reads, or the permissions probe that asks about writes', async () => {
    const { api, events } = auditedApi((_request, action) => action === 'read');

    await api.handle(request('GET', '/snapshots'));
    await api.handle(request('GET', '/head'));
    await api.handle(request('GET', '/permissions'));

    expect(events).toEqual([]);
  });

  it('answers the request the same when a sink throws, and says so once', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = createRegistryApi({
      store: memorySnapshotStore(),
      authorize: () => true,
      audit: [
        () => {
          throw new Error('sink down');
        },
        async () => {
          throw new Error('async sink down');
        },
      ],
    });

    expect((await api.handle(request('POST', '/snapshots', { manifests })))!.status).toBe(201);
    expect((await api.handle(request('POST', '/snapshots', { manifests })))!.status).toBe(201);
    await Promise.resolve();

    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe('jsonLinesAuditSink()', () => {
  it('writes one JSON object per line, for a log shipper to forward to a SIEM', async () => {
    const lines: string[] = [];
    const { api } = auditedApi();
    const sink = jsonLinesAuditSink((line) => void lines.push(line));
    const events: AuditEvent[] = [];
    const audited = createRegistryApi({
      store: memorySnapshotStore(),
      authorize: () => true,
      audit: [sink, (event) => void events.push(event)],
    });
    void api;

    await audited.handle(request('POST', '/snapshots', { manifests }));

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0])).toEqual(events[0]);
  });
});

describe('webhookAuditSink()', () => {
  const event = (n: number): AuditEvent => ({
    version: 1,
    at: new Date(0).toISOString(),
    action: 'publish',
    outcome: 'success',
    actor: `user${n}`,
    status: 201,
  });

  it('sends a batch as one POST', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    const sink = webhookAuditSink({ url: 'https://siem.example/ingest', headers: { authorization: 'Splunk t' }, batchSize: 3, fetch });

    [1, 2, 3].forEach((n) => sink(event(n)));
    await sink.flush();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://siem.example/ingest');
    expect(new Headers(init.headers).get('authorization')).toBe('Splunk t');
    expect(JSON.parse(String(init.body)).map((e: AuditEvent) => e.actor)).toEqual(['user1', 'user2', 'user3']);
  });

  it('flushes a partial batch after flushMs', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    const sink = webhookAuditSink({ url: 'https://siem.example/ingest', batchSize: 100, flushMs: 1000, fetch });

    sink(event(1));
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('drops the oldest events when its queue is full, and counts what it dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    const sink = webhookAuditSink({ url: 'https://siem.example/ingest', batchSize: 100, maxQueue: 2, fetch });

    [1, 2, 3, 4].forEach((n) => sink(event(n)));
    await sink.flush();

    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).map((e: AuditEvent) => e.actor)).toEqual([
      'user3',
      'user4',
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped 2'));
  });

  it('sends at most batchSize events per POST', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    const sink = webhookAuditSink({ url: 'https://siem.example/ingest', batchSize: 2, flushMs: 60_000, fetch });

    [1, 2, 3, 4, 5].forEach((n) => sink(event(n)));
    await sink.flush();

    const sizes = fetch.mock.calls.map((call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)).length);
    expect(sizes.every((size) => size <= 2)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('backs off while the endpoint is down, instead of retrying on every new event', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    const sink = webhookAuditSink({ url: 'https://siem.example/ingest', batchSize: 3, flushMs: 1000, fetch });

    for (let n = 0; n < 10; n++) sink(event(n));
    await vi.advanceTimersByTimeAsync(0);
    const duringOutage = fetch.mock.calls.length;

    expect(duringOutage).toBe(1);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);

    // and it retries on its own, without waiting for another event to arrive
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch.mock.calls.length).toBeGreaterThan(duringOutage);
  });

  it('gives up on a send that hangs, and keeps its events', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    );
    const sink = webhookAuditSink({ url: 'https://siem.example/ingest', batchSize: 1, timeoutMs: 500, fetch });

    sink(event(1));
    await vi.advanceTimersByTimeAsync(600);

    expect(sink.pending).toBe(1);
  });

  it('keeps a batch the endpoint refused, to send with the next flush', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 202 }));
    const sink = webhookAuditSink({ url: 'https://siem.example/ingest', batchSize: 100, fetch });

    sink(event(1));
    await sink.flush();
    sink(event(2));
    await sink.flush();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[1][1].body)).map((e: AuditEvent) => e.actor)).toEqual(['user1', 'user2']);
  });
});
