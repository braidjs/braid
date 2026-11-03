import { describe, expect, it } from 'vitest';
import type { FragmentManifest } from '@braidlabs/gateway';
import { diffRegistries, fieldOwner, validateRegistry } from './analysis.js';

const codes = (manifests: FragmentManifest[]) => validateRegistry(manifests).map((f) => f.code);

describe('validateRegistry', () => {
  it('passes a healthy registry', () => {
    expect(
      codes([
        { id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] },
        { id: 'reviews', endpoint: 'https://reviews.internal', pierce: ['/reviews/*'] },
      ]),
    ).toEqual([]);
  });

  it('catches duplicate ids, which otherwise silently resolve to the last one', () => {
    expect(
      codes([
        { id: 'billing', endpoint: 'https://a.internal' },
        { id: 'billing', endpoint: 'https://b.internal' },
      ]),
    ).toContain('duplicate-id');
  });

  it('catches ids that cannot be addressed in the namespace', () => {
    expect(codes([{ id: 'team/billing', endpoint: 'https://billing.internal' }])).toContain('invalid-id');
  });

  it('catches a relative endpoint, which has no origin on the server', () => {
    expect(codes([{ id: 'billing', endpoint: '/billing' }])).toContain('invalid-endpoint');
  });

  it('accepts a fetch function as an endpoint', () => {
    expect(codes([{ id: 'billing', endpoint: (async () => new Response('')) as unknown as typeof fetch }])).toEqual([]);
  });

  it('catches an invalid pierce pattern', () => {
    expect(codes([{ id: 'billing', endpoint: 'https://b.internal', pierce: ['/billing/((('] }])).toContain(
      'invalid-pierce-pattern',
    );
  });

  it('catches a custom-element fragment missing its element', () => {
    expect(
      codes([{ id: 'rating', endpoint: 'https://w.internal', adapter: 'custom-element', entry: '/w.js' }]),
    ).toContain('custom-element-incomplete');
  });

  it('warns about an empty access rule, which restricts nothing', () => {
    const findings = validateRegistry([{ id: 'billing', endpoint: 'https://b.internal', access: { list: { roles: [] } } }]);

    expect(findings[0]?.code).toBe('empty-access-rule');
    expect(findings[0]?.severity).toBe('warning');
  });

  describe('pierce overlap', () => {
    it('reports two fragments claiming the same page urls', () => {
      const findings = validateRegistry([
        { id: 'billing', endpoint: 'https://b.internal', pierce: ['/billing/*'] },
        { id: 'invoices', endpoint: 'https://i.internal', pierce: ['/billing/invoices'] },
      ]);

      const overlap = findings.find((f) => f.code === 'pierce-overlap');
      expect(overlap?.fragmentIds.sort()).toEqual(['billing', 'invoices']);
      expect(overlap?.severity).toBe('warning');
    });

    it('reports a stray wildcard swallowing everything', () => {
      expect(
        codes([
          { id: 'shell', endpoint: 'https://s.internal', pierce: ['/*'] },
          { id: 'billing', endpoint: 'https://b.internal', pierce: ['/billing/*'] },
        ]),
      ).toContain('pierce-overlap');
    });

    it('does not report disjoint patterns', () => {
      expect(
        codes([
          { id: 'billing', endpoint: 'https://b.internal', pierce: ['/billing/*'] },
          { id: 'orders', endpoint: 'https://o.internal', pierce: ['/orders/:id'] },
        ]),
      ).toEqual([]);
    });

    it('does not report a single fragment declaring several patterns', () => {
      expect(
        codes([{ id: 'billing', endpoint: 'https://b.internal', pierce: ['/billing', '/billing/*'] }]),
      ).toEqual([]);
    });
  });

  it('refuses a speculate value the gateway would refuse, and flags one with nothing to speculate', () => {
    const findings = validateRegistry([
      { id: 'a', endpoint: 'https://a.internal', pierce: ['/a'], speculate: 'soon' as unknown as 'prefetch' },
      { id: 'b', endpoint: 'https://b.internal', speculate: 'prerender' },
      { id: 'c', endpoint: 'https://c.internal', pierce: ['/c'], speculate: 'prefetch' },
    ]);

    expect(findings).toContainEqual(expect.objectContaining({ code: 'invalid-speculate', severity: 'error', fragmentIds: ['a'] }));
    expect(findings).toContainEqual(
      expect.objectContaining({ code: 'speculate-without-pierce', severity: 'warning', fragmentIds: ['b'] }),
    );
    expect(findings.filter((finding) => finding.fragmentIds.includes('c'))).toEqual([]);
  });
});

describe('diffRegistries', () => {
  const before: FragmentManifest[] = [
    { id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'], title: 'Billing' },
    { id: 'legacy', endpoint: 'https://legacy.internal' },
  ];

  it('reports an identical registry as identical', () => {
    expect(diffRegistries(before, [...before]).identical).toBe(true);
  });

  it('reports additions and removals', () => {
    const after: FragmentManifest[] = [before[0]!, { id: 'reviews', endpoint: 'https://reviews.internal' }];
    const diff = diffRegistries(before, after);

    expect(diff.added.map((m) => m.id)).toEqual(['reviews']);
    expect(diff.removed.map((m) => m.id)).toEqual(['legacy']);
    expect(diff.identical).toBe(false);
  });

  it('labels a routing change as gateway-owned', () => {
    const after = [{ ...before[0]!, pierce: ['/billing/*', '/invoices/*'] }, before[1]!];
    const change = diffRegistries(before, after).changed[0]?.changes[0];

    expect(change?.field).toBe('pierce');
    expect(change?.owner).toBe('gateway');
  });

  it('labels a description change as app-owned', () => {
    const after = [{ ...before[0]!, title: 'Billing & Invoices' }, before[1]!];
    const change = diffRegistries(before, after).changed[0]?.changes[0];

    expect(change?.field).toBe('title');
    expect(change?.owner).toBe('app');
  });

  it('treats two endpoint functions as different, because they cannot be compared structurally', () => {
    const a: FragmentManifest[] = [{ id: 'x', endpoint: (async () => new Response('')) as unknown as typeof fetch }];
    const b: FragmentManifest[] = [{ id: 'x', endpoint: (async () => new Response('')) as unknown as typeof fetch }];

    expect(diffRegistries(a, b).identical).toBe(false);
  });
});

describe('fieldOwner', () => {
  it.each(['endpoint', 'pierce', 'access', 'timeoutMs', 'fallback'])('%s is the gateway’s', (field) => {
    expect(fieldOwner(field)).toBe('gateway');
  });

  it.each(['title', 'description', 'tags', 'adapter', 'entry', 'element'])('%s may be self-reported', (field) => {
    expect(fieldOwner(field)).toBe('app');
  });
});
