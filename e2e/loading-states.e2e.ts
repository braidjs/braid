import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { endpoint, html, launch, startHost, type Host } from './harness.js';

/**
 * A host's `slot="loading"` child, in a real browser: CSS decides what is visible, which jsdom
 * cannot evaluate. Shown while a fragment boots with nothing of it on screen yet, after a delay;
 * gone at first paint, on error, and never for a pierced fragment.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const content = (id: string) => `<h1 id="${id}-content">${id}</h1>`;

let browser: Browser;
let host: Host;

beforeAll(async () => {
  browser = await launch();
  host = await startHost({
    gateway: {
      registry: [
        // its document takes a while: the skeleton should cover the wait
        { id: 'slow', endpoint: endpoint(async () => (await sleep(1_500), html(content('slow')))) },
        { id: 'instant', endpoint: endpoint(async () => (await sleep(1_500), html(content('instant')))) },
        // painted quickly, then held by a prerequisite before its code runs: still `loading`
        { id: 'gated', requires: ['hold'], endpoint: endpoint(() => html(content('gated'))) },
        { id: 'broken', endpoint: endpoint(async () => (await sleep(300), new Response('nope', { status: 500 }))) },
        { id: 'pierced', pierce: ['/'], endpoint: endpoint(() => html(content('pierced'))) },
      ],
    },
    head: `<style>[slot="loading"] { display: block; height: 40px; }</style>`,
    braidSource: `{ prerequisites: { hold: function () { return new Promise(function () {}); } } }`,
    body: ['slow', 'gated', 'broken', 'pierced']
      .map(
        (id) =>
          `<fragment-slot name="${id}"><div slot="loading" id="${id}-skeleton" aria-hidden="true">…</div>` +
          `<p slot="fallback" id="${id}-fallback">unavailable</p></fragment-slot>`,
      )
      .concat(
        '<fragment-slot name="instant" style="--braid-loading-delay: 0s"><div slot="loading" id="instant-skeleton">…</div></fragment-slot>',
      )
      .join(''),
  });
});

afterAll(async () => {
  await browser?.close();
  await host?.close();
});

async function open(): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(host.url);
  return page;
}

const visible = (page: Page, selector: string) => page.isVisible(selector);

describe('slot="loading"', () => {
  it('stays hidden for a fast moment, then shows while nothing of the fragment is on screen', async () => {
    const page = await open();
    await page.waitForSelector('fragment-slot[name="slow"][state="loading"]', { state: 'attached' });
    expect(await visible(page, '#slow-skeleton')).toBe(false);
    await page.waitForTimeout(500);
    expect(await visible(page, '#slow-skeleton')).toBe(true);
    expect(await page.getAttribute('fragment-slot[name="slow"]', 'aria-busy')).toBe('true');

    await page.waitForSelector('#slow-content', { state: 'attached', timeout: 10_000 });
    await page.waitForSelector('fragment-slot[name="slow"]:is([state="ready"], [state="healthy"])', { state: 'attached' });
    expect(await visible(page, '#slow-skeleton')).toBe(false);
    expect(await page.getAttribute('fragment-slot[name="slow"]', 'aria-busy')).toBeNull();
    await page.close();
  });

  it('gives way at first paint, before the fragment is ready', async () => {
    const page = await open();
    await page.waitForFunction(() => document.querySelector('fragment-slot[name="gated"]')?.shadowRoot?.querySelector('#gated-content'));
    await page.waitForTimeout(500);
    expect(await page.getAttribute('fragment-slot[name="gated"]', 'state')).toBe('loading');
    expect(await visible(page, '#gated-skeleton')).toBe(false);
    await page.close();
  });

  it('gives way to the fallback on error', async () => {
    const page = await open();
    await page.waitForSelector('fragment-slot[name="broken"][state="error"]', { state: 'attached', timeout: 10_000 });
    expect(await visible(page, '#broken-skeleton')).toBe(false);
    expect(await visible(page, '#broken-fallback')).toBe(true);
    await page.close();
  });

  it('never shows for a pierced fragment, whose content is already there', async () => {
    const page = await open();
    for (let i = 0; i < 10; i++) {
      expect(await visible(page, '#pierced-skeleton'), `sample ${i}`).toBe(false);
      await page.waitForTimeout(100);
    }
    await page.close();
  });

  it('shows at once with --braid-loading-delay: 0s', async () => {
    const page = await open();
    await page.waitForSelector('fragment-slot[name="instant"][state="loading"]', { state: 'attached' });
    await page.waitForTimeout(50);
    expect(await visible(page, '#instant-skeleton')).toBe(true);
    await page.close();
  });
});
