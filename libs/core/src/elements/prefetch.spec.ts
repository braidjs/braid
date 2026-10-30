import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initBraid, prefetchFragment } from '../index.js';
import { clearPrefetchedFragments, PREFETCH_TTL_MS } from './prefetch.js';

const DOCUMENT =
  '<braid-html><braid-body><h1>Invoices</h1>' +
  '<script type="inert" data-script-type="module" src="/__braid/frag/billing/main.js"></script>' +
  '<script type="inert" src="/__braid/frag/billing/legacy.js"></script>' +
  '</braid-body></braid-html>';

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('prefetchFragment()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const documentRequests = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/__braid/doc/'));

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(DOCUMENT, { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);
    initBraid();
  });

  afterEach(() => {
    clearPrefetchedFragments();
    vi.useRealTimers();
    document.body.replaceChildren();
    document.head.querySelectorAll('link[rel="prefetch"]').forEach((link) => link.remove());
    vi.unstubAllGlobals();
  });

  it('hands its document to the next slot for that fragment and route: one request in all', async () => {
    prefetchFragment('billing', '/billing/invoices');
    expect(documentRequests()).toHaveLength(1);
    expect(String(documentRequests()[0][0])).toBe('/__braid/doc/billing/billing/invoices');

    document.body.innerHTML = '<fragment-slot name="billing" src="/billing/invoices"></fragment-slot>';
    const slot = document.querySelector('fragment-slot')!;
    await vi.waitFor(() => expect(slot.shadowRoot?.querySelector('h1')?.textContent).toBe('Invoices'));
    expect(documentRequests()).toHaveLength(1);
  });

  it('is used once: a second slot fetches its own', async () => {
    prefetchFragment('billing', '/billing/invoices');
    document.body.innerHTML = '<fragment-slot name="billing" src="/billing/invoices"></fragment-slot>';
    await settle();
    document.body.insertAdjacentHTML('beforeend', '<fragment-slot name="billing" src="/billing/invoices"></fragment-slot>');
    await settle();
    expect(documentRequests()).toHaveLength(2);
  });

  it('is not used for a different route', async () => {
    prefetchFragment('billing', '/billing/invoices');
    document.body.innerHTML = '<fragment-slot name="billing" src="/billing/settings"></fragment-slot>';
    await settle();
    expect(documentRequests().map(([url]) => String(url))).toEqual([
      '/__braid/doc/billing/billing/invoices',
      '/__braid/doc/billing/billing/settings',
    ]);
  });

  it('expires after its time to live, aborting the request it held', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    prefetchFragment('billing', '/billing/invoices');
    const signal = (documentRequests()[0][1] as RequestInit).signal!;
    vi.advanceTimersByTime(PREFETCH_TTL_MS + 1);
    vi.useRealTimers();
    expect(signal.aborted).toBe(true);

    document.body.innerHTML = '<fragment-slot name="billing" src="/billing/invoices"></fragment-slot>';
    await settle();
    expect(documentRequests()).toHaveLength(2);
  });

  it('does nothing more for a fragment and route already held', () => {
    prefetchFragment('billing', '/billing/invoices');
    prefetchFragment('billing', '/billing/invoices');
    expect(documentRequests()).toHaveLength(1);
  });

  it('hints the realm stub, and the document’s scripts in the CORS mode the realm will use', async () => {
    prefetchFragment('billing', '/billing/invoices');
    await settle();
    const hints = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="prefetch"]')].map((link) => [
      link.getAttribute('href'),
      link.getAttribute('crossorigin'),
    ]);
    expect(hints).toEqual([
      ['/__braid/realm/billing/', null],
      ['/__braid/frag/billing/main.js', ''],
      ['/__braid/frag/billing/legacy.js', null],
    ]);
  });
});
