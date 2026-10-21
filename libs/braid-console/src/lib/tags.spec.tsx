import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { DiscoveryEntry } from '@braidlabs/gateway';
import { RegistryConsole } from './registry-console.js';
import { TAG_COLOR_COUNT, tagClass, tagColor } from './tags.js';

describe('tagColor', () => {
  it('gives a tag the same slot every time, whatever its case', () => {
    expect(tagColor('finance')).toBe(tagColor('finance'));
    expect(tagColor('Finance')).toBe(tagColor('finance'));
  });

  it('stays within the palette', () => {
    for (const tag of ['', 'a', 'finance', 'a very long tag with spaces', 'ünïcødé']) {
      expect(tagColor(tag)).toBeGreaterThanOrEqual(0);
      expect(tagColor(tag)).toBeLessThan(TAG_COLOR_COUNT);
    }
  });

  it('spreads different tags across the palette', () => {
    const tags = ['finance', 'feedback', 'widget', 'chrome', 'core', 'partners', 'payments', 'search', 'identity', 'orders'];
    const slots = new Set(tags.map(tagColor));

    expect(slots.size).toBeGreaterThanOrEqual(5);
  });
});

describe('tag chips', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.getElementById('braid-console-styles')?.remove();
  });

  it('colors a tag the same in the fragment table as everywhere else, and filters by it on click', async () => {
    const entries: DiscoveryEntry[] = [
      { id: 'billing', title: 'Billing', adapter: 'compat', mount: '/m/', loadable: true, bound: true, tags: ['finance'] },
      { id: 'reviews', title: 'Reviews', adapter: 'compat', mount: '/m/', loadable: true, bound: true, tags: ['feedback'] },
    ];
    const body = { items: entries, page: 1, pageSize: 100, total: 2, totalPages: 1, hasMore: false, protocolVersion: '2' };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
    const container = document.body.appendChild(document.createElement('div'));
    const root = createRoot(container);

    await act(async () => root.render(<RegistryConsole api={{ fetch: fetchMock as unknown as typeof fetch }} />));

    const chip = container.querySelector<HTMLButtonElement>('button[aria-label="Filter by tag finance"]');
    expect(chip?.className).toBe(`${tagClass('finance')} braid-console__tagbutton`);

    await act(async () => chip?.click());

    expect(container.querySelector<HTMLInputElement>('.braid-console__search')?.value).toBe('tag:finance');
    expect(container.textContent).toContain('billing');
    expect(container.textContent).not.toContain('reviews');
    act(() => root.unmount());
  });
});
