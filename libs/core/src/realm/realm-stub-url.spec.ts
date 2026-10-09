import { afterEach, describe, expect, it, vi } from 'vitest';
import { initBraid } from '../index.js';
import { pointStubAtRoute } from './realm-manager.js';

/**
 * The realm stub is one URL per fragment, so it caches and precaches as one resource instead of
 * a cold request for every route and query string.
 */
describe('realm stub url', () => {
  afterEach(() => {
    document.body.replaceChildren();
    history.replaceState(null, '', '/');
    vi.unstubAllGlobals();
  });

  async function stubUrlAt(route: string): Promise<string> {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<p>x</p>', { headers: { 'content-type': 'text/html' } })));
    history.replaceState(null, '', route);
    document.body.innerHTML = '<fragment-slot name="billing"></fragment-slot>';
    await vi.waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    const src = document.querySelector('iframe')!.getAttribute('src')!;
    document.body.replaceChildren();
    return src;
  }

  it('is the same for every route and query', async () => {
    initBraid();

    expect(await stubUrlAt('/billing/invoices?page=2')).toBe('/__braid/realm/billing/');
    expect(await stubUrlAt('/billing/invoices/42?utm_source=mail')).toBe('/__braid/realm/billing/');
  });
});

describe('pointStubAtRoute()', () => {
  const stub = (html: string) => new DOMParser().parseFromString(html, 'text/html');

  it('re-points the stub’s <base> at the route, as the gateway would have for a stub fetched there', () => {
    const doc = stub('<base href="/__braid/frag/billing/"><meta name="braid-protocol" content="2">');

    pointStubAtRoute(doc, '/__braid/frag/billing/invoices/42');

    expect(doc.querySelectorAll('base')).toHaveLength(1);
    expect(doc.baseURI.endsWith('/__braid/frag/billing/invoices/42')).toBe(true);
  });

  it('adds a <base> to a stub that has none', () => {
    const doc = stub('<meta name="braid-protocol" content="2">');

    pointStubAtRoute(doc, '/__braid/frag/billing/invoices/42');

    expect(doc.querySelector('base')?.getAttribute('href')).toBe('/__braid/frag/billing/invoices/42');
  });
});
