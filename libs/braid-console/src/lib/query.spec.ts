import { describe, expect, it } from 'vitest';
import type { DiscoveryEntry } from '@braidlabs/gateway';
import type { ShellManifest } from '@braidlabs/registry';
import { filterBy, fragmentItem, matchQuery, parseQuery, shellItem, type SearchItem } from './query.js';

const entry = (over: Partial<DiscoveryEntry>): DiscoveryEntry => ({
  id: 'x',
  title: 'X',
  adapter: 'compat',
  mount: '/__braid/frag/x/',
  loadable: true,
  bound: true,
  ...over,
});

const billing = entry({ id: 'billing', title: 'Billing', tags: ['finance'], pierce: ['/billing/*'] });
const payroll = entry({ id: 'payroll', title: 'Payroll', tags: ['finance'], pierce: ['/payroll/*'], loadable: false });
const rating = entry({ id: 'rating', title: 'Star rating', tags: ['widget'], adapter: 'custom-element' });
const reviews = entry({ id: 'reviews', title: 'Customer reviews', tags: ['feedback'], pierce: ['/billing/*'] });

const portal: ShellManifest = {
  id: 'portal',
  title: 'Customer portal',
  framework: 'angular-ssr',
  tags: ['core'],
  routes: [{ path: '/billing/*', layout: { areas: 'main' }, slots: { main: 'billing' } }],
};

const items: SearchItem[] = [billing, payroll, rating, reviews].map(fragmentItem).concat(shellItem(portal));
const ids = (query: string) => filterBy(items, query, (item) => item).map((item) => item.id);

describe('parseQuery', () => {
  it('splits known keys from free text', () => {
    expect(parseQuery('tag:finance billing')).toEqual({
      terms: [{ key: 'tag', value: 'finance', negate: false }],
      text: 'billing',
      exclude: [],
    });
  });

  it('reads negation and quoted values', () => {
    expect(parseQuery('-tag:"two words" -noise').terms).toEqual([{ key: 'tag', value: 'two words', negate: true }]);
    expect(parseQuery('-noise').exclude).toEqual(['noise']);
  });

  it('treats unknown keys as text', () => {
    expect(parseQuery('owner:payments')).toEqual({ terms: [], text: 'owner:payments', exclude: [] });
  });

  it('keeps a plain query exactly as typed, internal spacing included', () => {
    expect(parseQuery('  Customer  reviews ').text).toBe('customer  reviews');
  });
});

describe('matchQuery', () => {
  it('filters by tag and type together', () => {
    expect(ids('tag:finance type:fragment')).toEqual(['billing', 'payroll']);
  });

  it('negates a term', () => {
    expect(ids('tag:finance -is:gated')).toEqual(['billing']);
  });

  it('filters shells by framework', () => {
    expect(ids('framework:angular-ssr')).toEqual(['portal']);
    expect(ids('type:shell')).toEqual(['portal']);
  });

  it('filters by adapter', () => {
    expect(ids('adapter:custom-element')).toEqual(['rating']);
  });

  it('matches a route pattern as written, or a concrete path it serves', () => {
    expect(ids('route:/billing/*')).toEqual(['billing', 'reviews', 'portal']);
    expect(ids('route:/billing/invoice-42')).toEqual(['billing', 'reviews', 'portal']);
    expect(ids('route:/payroll/*')).toEqual(['payroll']);
  });

  it('finds unrouted fragments, which are widgets', () => {
    expect(ids('is:unrouted')).toEqual(['rating']);
  });

  it('matches a quoted phrase as free text', () => {
    expect(ids('"customer reviews"')).toEqual(['reviews']);
  });

  it('excludes rows containing a negated word', () => {
    expect(ids('tag:finance -payroll')).toEqual(['billing']);
  });

  it('finds a shell by a fragment it slots', () => {
    expect(ids('type:shell billing')).toEqual(['portal']);
  });

  it('returns nothing for an unknown is: value rather than everything', () => {
    expect(ids('is:sparkly')).toEqual([]);
  });

  it('returns everything for an empty query', () => {
    expect(ids('   ')).toHaveLength(items.length);
    expect(matchQuery(items[0]!, parseQuery(''))).toBe(true);
  });
});
