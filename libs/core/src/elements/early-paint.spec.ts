import { afterEach, describe, expect, it, vi } from 'vitest';
import { initBraid } from '../index.js';

/**
 * A client-fetched fragment paints when its document arrives, not when its realm has booted.
 *
 * The document is already inert — scripts neutralized by the gateway — so it can go on screen
 * immediately, exactly as server-pierced content does. Its code still runs only after boot.
 */
describe('early paint', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('shows the fragment document before the realm has loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<braid-html><braid-body><h1>Invoices</h1></braid-body></braid-html>', {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
      ),
    );
    initBraid();
    document.body.innerHTML = '<fragment-slot name="billing"></fragment-slot>';
    const slot = document.querySelector('fragment-slot')!;

    // jsdom never loads the realm iframe, so anything on screen got there before boot
    await vi.waitFor(() => expect(slot.shadowRoot?.querySelector('h1')?.textContent).toBe('Invoices'));
    expect(slot.getAttribute('state')).not.toBe('ready');
  });

  it('paints nothing that did not arrive as html, which the gateway would not have prepared', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<img src=x onerror="hostRealmCode()"><h1>raw</h1>', { headers: { 'content-type': 'text/plain' } })),
    );
    initBraid();
    document.body.innerHTML = '<fragment-slot name="billing"></fragment-slot>';
    const slot = document.querySelector('fragment-slot')!;

    await vi.waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.shadowRoot!.querySelector('braid-document')!.childElementCount).toBe(0);
  });

  it('paints nothing for a fragment that has no document', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    initBraid();
    document.body.innerHTML = '<fragment-slot name="rating"></fragment-slot>';
    const slot = document.querySelector('fragment-slot')!;

    await vi.waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.shadowRoot!.querySelector('braid-document')!.childElementCount).toBe(0);
  });
});
