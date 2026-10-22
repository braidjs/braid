import { describe, expect, it, vi } from 'vitest';
import type { FragmentManifest } from '@braidlabs/gateway';
import { fetchDescriptors, mergeDescriptors, type FragmentDescriptor } from './descriptor.js';

const billing: FragmentManifest = { id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] };

const descriptors = (entries: Record<string, FragmentDescriptor | Error>) => new Map(Object.entries(entries));

describe('mergeDescriptors', () => {
  it('supplies a field the manifest leaves unset', () => {
    const { manifests, notes } = mergeDescriptors([billing], descriptors({ billing: { title: 'Billing' } }));

    expect(manifests[0]?.title).toBe('Billing');
    expect(notes[0]).toMatchObject({ kind: 'applied', field: 'title' });
  });

  it('leaves an explicit manifest value alone — the human override wins', () => {
    const pinned = { ...billing, title: 'Billing (pinned)' };

    const { manifests } = mergeDescriptors([pinned], descriptors({ billing: { title: 'Billing' } }));

    expect(manifests[0]?.title).toBe('Billing (pinned)');
  });

  it('surfaces a disagreement rather than resolving it silently', () => {
    const pinned = { ...billing, title: 'Billing (pinned)' };

    const { notes } = mergeDescriptors([pinned], descriptors({ billing: { title: 'Billing' } }));

    expect(notes[0]).toMatchObject({
      kind: 'disagreement',
      field: 'title',
      manifestValue: 'Billing (pinned)',
      descriptorValue: 'Billing',
    });
    expect(notes[0]?.message).toMatch(/check whether the app moved/);
  });

  it('says nothing when the manifest and descriptor agree', () => {
    const { notes } = mergeDescriptors([{ ...billing, title: 'Billing' }], descriptors({ billing: { title: 'Billing' } }));

    expect(notes).toEqual([]);
  });

  it.each(['pierce', 'access', 'endpoint', 'timeoutMs', 'fallback'])(
    'refuses a descriptor that tries to set %s, and reports the attempt',
    (field) => {
      const { manifests, notes } = mergeDescriptors(
        [billing],
        descriptors({ billing: { [field]: 'anything' } as unknown as FragmentDescriptor }),
      );

      expect((manifests[0] as Record<string, unknown>)[field]).toEqual(
        (billing as Record<string, unknown>)[field],
      );
      expect(notes[0]).toMatchObject({ kind: 'rejected-field', field });
      expect(notes[0]?.message).toMatch(/only the gateway may set/);
      // never echoed: the probe runs inside the server's network
      expect(notes[0]).not.toHaveProperty('descriptorValue');
    },
  );

  it('ignores an unknown field without pretending it was hostile', () => {
    const { notes } = mergeDescriptors(
      [billing],
      descriptors({ billing: { somethingNew: 1 } as unknown as FragmentDescriptor }),
    );

    expect(notes[0]).toMatchObject({ kind: 'rejected-field', field: 'somethingNew' });
    expect(notes[0]?.message).toMatch(/unrecognized field/);
  });

  it('reports an unreachable descriptor and keeps the manifest', () => {
    const { manifests, notes } = mergeDescriptors([billing], descriptors({ billing: new Error('connection refused') }));

    expect(manifests[0]).toEqual(billing);
    expect(notes[0]).toMatchObject({ kind: 'unreachable' });
  });

  it('leaves fragments with no descriptor completely untouched', () => {
    const { manifests, notes } = mergeDescriptors([billing], new Map());

    expect(manifests[0]).toEqual(billing);
    expect(notes).toEqual([]);
  });

  it('ignores the format version marker', () => {
    const { notes } = mergeDescriptors([billing], descriptors({ billing: { braid: '1' } }));

    expect(notes).toEqual([]);
  });
});

describe('fetchDescriptors', () => {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('reads the well-known path on the fragment’s own endpoint', async () => {
    const fetchMock = vi.fn(async () => ok({ title: 'Billing' }));

    const result = await fetchDescriptors([billing], { fetch: fetchMock as unknown as typeof fetch });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://billing.internal/.well-known/braid/fragment.json');
    expect(result.get('billing')).toEqual({ title: 'Billing' });
  });

  it('preserves an endpoint path prefix rather than escaping to the origin root', async () => {
    const fetchMock = vi.fn(async () => ok({}));

    await fetchDescriptors([{ id: 'x', endpoint: 'https://internal/apps/billing' }], {
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toContain('/apps/billing/.well-known/');
  });

  it('treats 404 as the supported default — publishing nothing', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));

    const result = await fetchDescriptors([billing], { fetch: fetchMock as unknown as typeof fetch });

    expect(result.has('billing')).toBe(false);
  });

  it('records a failure instead of throwing, so one bad fragment cannot block a publish', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connection refused');
    });

    const result = await fetchDescriptors([billing], { fetch: fetchMock as unknown as typeof fetch });

    expect(result.get('billing')).toBeInstanceOf(Error);
  });

  it('does not follow a redirect, which could point the probe anywhere on the server network', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }));

    const result = await fetchDescriptors([billing], { fetch: fetchMock as unknown as typeof fetch });

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'manual' }));
    expect((result.get('billing') as Error).message).toMatch(/redirected/);
  });

  it('refuses a descriptor larger than a descriptor could be, without reading it all', async () => {
    const huge = JSON.stringify({ title: 'x'.repeat(100 * 1024) });
    const declared = vi.fn(async () => new Response(huge, { headers: { 'content-length': String(huge.length) } }));
    // no content-length: caught while streaming
    const streamed = vi.fn(async () => new Response(new Blob([huge]).stream()));

    for (const fetchMock of [declared, streamed]) {
      const result = await fetchDescriptors([billing], { fetch: fetchMock as unknown as typeof fetch });
      expect((result.get('billing') as Error).message).toMatch(/limit is|exceeds/);
    }
  });

  it('records a non-object body as invalid', async () => {
    const fetchMock = vi.fn(async () => ok('just a string'));

    const result = await fetchDescriptors([billing], { fetch: fetchMock as unknown as typeof fetch });

    expect((result.get('billing') as Error).message).toMatch(/must be a JSON object/);
  });

  it('skips in-process endpoints, which have no well-known path', async () => {
    const fetchMock = vi.fn(async () => ok({}));

    const result = await fetchDescriptors(
      [{ id: 'x', endpoint: (async () => new Response('')) as unknown as typeof fetch }],
      { fetch: fetchMock as unknown as typeof fetch },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it('probes every fragment concurrently', async () => {
    const fetchMock = vi.fn(async () => ok({ title: 't' }));

    const result = await fetchDescriptors(
      [billing, { id: 'reviews', endpoint: 'https://reviews.internal' }],
      { fetch: fetchMock as unknown as typeof fetch },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(2);
  });
});
