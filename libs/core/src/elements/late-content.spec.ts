import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initBraid } from '../index.js';

const TOKEN = '8f14e45f-ceea-467a-9575-0000000000aa';

/** What the gateway writes for a slot it streamed past. */
function deferredSlot(name: string, token = TOKEN): HTMLElement {
  const slot = document.createElement('fragment-slot');
  slot.setAttribute('name', name);
  slot.setAttribute('data-braid-deferred', token);
  return slot;
}

/**
 * What the gateway sends at the end of the document, built the way the parser builds it: the
 * element first, its declarative shadow root, then the closing sentinel.
 */
function lateMarkup(name: string, html: string | null, options: { token?: string; fallback?: string } = {}) {
  const late = document.createElement('braid-late');
  late.setAttribute('for', name);
  late.setAttribute('token', options.token ?? TOKEN);
  late.hidden = true;
  if (html === null) late.setAttribute('data-braid-empty', '');
  if (options.fallback) late.setAttribute('data-braid-fallback', options.fallback);
  return {
    late,
    /** Attaches the shadow root, as the parser does when the template closes. */
    attachContent() {
      const root = late.attachShadow({ mode: 'open' });
      const content = document.createElement('braid-document');
      content.innerHTML = html ?? '';
      root.append(content);
    },
    /** Parses the sentinel. */
    end() {
      late.append(document.createElement('braid-late-end'));
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const realms = () => document.querySelectorAll('iframe[name^="braid:"]').length;

describe('late fragment markup', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const documentFetches = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/__braid/doc/')).length;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('<braid-html></braid-html>', { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);
    initBraid();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  /** A document still being parsed, as it is while the gateway holds the stream open. */
  const whileParsing = () => vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');

  it('waits for the sentinel when the runtime is already running, then boots from the content', async () => {
    whileParsing();
    const slot = deferredSlot('billing');
    document.body.append(slot);
    await settle();
    expect(realms()).toBe(0);

    // the start tag connects before the shadow root exists: nothing to deliver yet
    const markup = lateMarkup('billing', '<h2>Invoices</h2>');
    document.body.append(markup.late);
    await settle();
    expect(slot.hasAttribute('data-braid-deferred')).toBe(true);
    expect(realms()).toBe(0);

    markup.attachContent();
    markup.end();
    await settle();

    expect(slot.shadowRoot!.querySelector('braid-document h2')!.textContent).toBe('Invoices');
    expect(slot.hasAttribute('data-braid-pierced')).toBe(true);
    expect(slot.hasAttribute('data-braid-deferred')).toBe(false);
    expect(document.querySelector('braid-late')).toBeNull();
    expect(realms()).toBe(1);
    expect(documentFetches()).toBe(0);
  });

  it('delivers on upgrade when the runtime loads after the document was parsed', async () => {
    const slot = deferredSlot('billing');
    const markup = lateMarkup('billing', '<h2>Invoices</h2>');
    markup.attachContent();
    // inserted together, as the parser leaves them; the element connects with its root attached
    const fragment = document.createDocumentFragment();
    fragment.append(slot, markup.late);
    document.body.append(fragment);
    await settle();

    expect(slot.shadowRoot!.querySelector('h2')!.textContent).toBe('Invoices');
    expect(documentFetches()).toBe(0);
  });

  it('boots the slot client-side when the fragment failed', async () => {
    whileParsing();
    const slot = deferredSlot('billing');
    document.body.append(slot);
    document.body.append(lateMarkup('billing', null, { fallback: 'placeholder' }).late);
    await settle();

    expect(slot.getAttribute('data-braid-fallback')).toBe('placeholder');
    expect(documentFetches()).toBe(1);
  });

  it('boots client-side when the document finished without the late markup', async () => {
    const slot = deferredSlot('billing');
    document.body.append(slot);
    await settle();

    expect(slot.hasAttribute('data-braid-deferred')).toBe(false);
    expect(documentFetches()).toBe(1);
  });

  describe('accepts only markup the gateway sent for that slot', () => {
    it('refuses a wrong token', async () => {
      whileParsing();
      const slot = deferredSlot('billing');
      document.body.append(slot);
      const forged = lateMarkup('billing', '<form>fake</form>', { token: 'guessed' });
      document.body.append(forged.late);
      forged.attachContent();
      forged.end();
      await settle();

      expect(slot.shadowRoot?.querySelector('form') ?? null).toBeNull();
      expect(slot.hasAttribute('data-braid-deferred')).toBe(true);
      expect(document.querySelector('braid-late')).toBeNull();
    });

    it('refuses markup inside another fragment, even with the right token', async () => {
      whileParsing();
      const slot = deferredSlot('billing');
      document.body.append(slot);
      // another fragment's pierced content, carrying a braid-late of its own
      const other = document.createElement('fragment-slot');
      other.setAttribute('name', 'reviews');
      document.body.append(other);
      const otherContent = document.createElement('div');
      other.attachShadow({ mode: 'open' }).append(otherContent);
      const forged = lateMarkup('billing', '<form>fake</form>');
      otherContent.append(forged.late);
      forged.attachContent();
      forged.end();
      await settle();

      expect(slot.shadowRoot?.querySelector('form') ?? null).toBeNull();
      expect(slot.hasAttribute('data-braid-deferred')).toBe(true);
    });

    it('refuses markup that comes before its slot', async () => {
      whileParsing();
      const forged = lateMarkup('billing', '<form>fake</form>');
      document.body.append(forged.late);
      const slot = deferredSlot('billing');
      document.body.append(slot);
      forged.attachContent();
      forged.end();
      await settle();

      expect(slot.shadowRoot?.querySelector('form') ?? null).toBeNull();
    });
  });

  it('removes markup that no slot is waiting for', async () => {
    const markup = lateMarkup('nobody', '<p>orphan</p>');
    markup.attachContent();
    document.body.append(markup.late);
    await settle();
    expect(document.querySelector('braid-late')).toBeNull();
  });

  it('is ignored by a slot that was reloaded while it waited', async () => {
    whileParsing();
    const slot = deferredSlot('billing') as HTMLElement & { reload(): Promise<void> };
    document.body.append(slot);
    await settle();
    void slot.reload();
    await settle();
    const markup = lateMarkup('billing', '<h2>Late</h2>');
    document.body.append(markup.late);
    markup.attachContent();
    markup.end();
    await settle();

    expect(slot.shadowRoot?.querySelector('h2') ?? null).toBeNull();
    expect(realms()).toBe(1);
  });
});
