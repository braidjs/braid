import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initBraid } from '../index.js';

/** What the gateway writes for a slot it streamed past. */
function deferredSlot(name: string): HTMLElement {
  const slot = document.createElement('fragment-slot');
  slot.setAttribute('name', name);
  slot.setAttribute('data-braid-deferred', '');
  return slot;
}

/** What the gateway sends at the end of the document; the parser attaches its declarative root. */
function lateMarkup(name: string, html: string | null, fallback?: string): HTMLElement {
  const late = document.createElement('braid-late');
  late.setAttribute('for', name);
  late.hidden = true;
  if (fallback) late.setAttribute('data-braid-fallback', fallback);
  if (html !== null) {
    const root = late.attachShadow({ mode: 'open' });
    const content = document.createElement('braid-document');
    content.innerHTML = html;
    root.append(content);
  }
  return late;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const documentFetches = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('/__braid/doc/')).length;

describe('late fragment markup', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('<braid-html></braid-html>', { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);
    initBraid();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('moves into its slot, which then boots from it without fetching the document', async () => {
    // still parsing, as a real page is while the gateway holds the stream open for late fragments
    const readyState = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    const slot = deferredSlot('billing');
    document.body.append(slot);
    await settle();
    // waiting for its markup: neither booted nor fetching
    expect(document.querySelectorAll('iframe[name^="braid:"]')).toHaveLength(0);

    document.body.append(lateMarkup('billing', '<h2>Invoices</h2>'));
    readyState.mockRestore();
    await settle();

    expect(slot.shadowRoot!.querySelector('braid-document h2')!.textContent).toBe('Invoices');
    expect(slot.hasAttribute('data-braid-pierced')).toBe(true);
    expect(slot.hasAttribute('data-braid-deferred')).toBe(false);
    expect(document.querySelector('braid-late')).toBeNull();
    expect(document.querySelectorAll('iframe[name^="braid:"]')).toHaveLength(1);
    expect(documentFetches(fetchMock)).toBe(0);
  });

  it('boots the slot client-side when the fragment failed', async () => {
    const slot = deferredSlot('billing');
    document.body.append(slot);
    document.body.append(lateMarkup('billing', null, 'placeholder'));
    await settle();

    expect(slot.getAttribute('data-braid-fallback')).toBe('placeholder');
    expect(documentFetches(fetchMock)).toBe(1);
  });

  it('boots client-side when the document finished without the late markup', async () => {
    // jsdom's document has finished loading, as it would after a response that was cut short
    const slot = deferredSlot('billing');
    document.body.append(slot);
    await settle();

    expect(slot.hasAttribute('data-braid-deferred')).toBe(false);
    expect(documentFetches(fetchMock)).toBe(1);
  });

  it('removes markup that no slot is waiting for', async () => {
    document.body.append(lateMarkup('nobody', '<p>orphan</p>'));
    await settle();
    expect(document.querySelector('braid-late')).toBeNull();
  });
});
