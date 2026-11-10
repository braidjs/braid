import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { endpoint, html, launch, startHost, type Host } from './harness.js';

/**
 * A host's `slot="loading"` child, in a real browser: CSS decides what is visible, which jsdom
 * cannot evaluate. Shown while a fragment boots with nothing of it on screen yet, after a delay;
 * gone at first paint, on error, and never for a pierced fragment.
 *
 * No check here needs something to have happened by a wall-clock time. A fragment that must still
 * be loading is held until the test lets it go, and the delay is measured by the page's own clock,
 * between the slot turning `loading` and the first frame the skeleton is visible in — so a busy
 * machine makes a run slower, never wrong. The waits that remain only give something that must
 * not happen the time to happen.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const content = (id: string) => `<h1 id="${id}-content">${id}</h1>`;

let browser: Browser;
let host: Host;

/** Holds the `slow`, `instant` and `hostbusy` documents until the test calls it. */
let release: () => void = () => undefined;
let held: Promise<void> = Promise.resolve();

beforeEach(() => {
  held = new Promise((resolve) => (release = resolve));
});
// so a page a test has finished with never leaves a request waiting
afterEach(() => release());

beforeAll(async () => {
  browser = await launch();
  host = await startHost({
    gateway: {
      registry: [
        // its document takes a while: the skeleton should cover the wait
        { id: 'slow', endpoint: endpoint(async () => (await held, html(content('slow')))) },
        { id: 'instant', endpoint: endpoint(async () => (await held, html(content('instant')))) },
        // painted quickly, then held by a prerequisite before its code runs: still `loading`
        { id: 'gated', requires: ['hold'], endpoint: endpoint(() => html(content('gated'))) },
        { id: 'broken', endpoint: endpoint(async () => (await sleep(300), new Response('nope', { status: 500 }))) },
        { id: 'pierced', pierce: ['/'], endpoint: endpoint(() => html(content('pierced'))) },
        { id: 'hostbusy', endpoint: endpoint(async () => (await held, html(content('hostbusy')))) },
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
        '<fragment-slot name="hostbusy" aria-busy="false"><div slot="loading">…</div></fragment-slot>',
      )
      .join(''),
  });
});

afterAll(async () => {
  await browser?.close();
  await host?.close();
});

interface Timings {
  /** When each slot turned `loading`, by name, on the page's clock. */
  __loadingAt: Record<string, number>;
  /** The first frame each skeleton was visible in, by element id. */
  __shownAt: Record<string, number>;
}

async function open(): Promise<Page> {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const timings = window as unknown as Timings;
    timings.__loadingAt = {};
    timings.__shownAt = {};
    new MutationObserver((records) => {
      for (const { target } of records) {
        const slot = target as Element;
        const name = slot.getAttribute('name');
        if (slot.localName === 'fragment-slot' && name && slot.getAttribute('state') === 'loading') timings.__loadingAt[name] ??= performance.now();
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['state'] });
    const sample = () => {
      for (const skeleton of document.querySelectorAll('[slot="loading"][id]')) {
        // before its slot is upgraded a skeleton is an ordinary child, and shows: not what is timed here
        if (timings.__loadingAt[skeleton.id.replace(/-skeleton$/, '')] === undefined) continue;
        if (timings.__shownAt[skeleton.id] !== undefined) continue;
        if (skeleton.getClientRects().length > 0 && getComputedStyle(skeleton).visibility === 'visible') timings.__shownAt[skeleton.id] = performance.now();
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto(host.url);
  return page;
}

const visible = (page: Page, selector: string) => page.isVisible(selector);

/** Milliseconds from the slot turning `loading` to its skeleton's first visible frame; waits for that frame. */
async function shownAfter(page: Page, name: string): Promise<number> {
  await page.waitForFunction((id) => (window as unknown as Timings).__shownAt[`${id}-skeleton`] !== undefined, name, { timeout: 20_000 });
  return page.evaluate((id) => {
    const { __shownAt, __loadingAt } = window as unknown as Timings;
    return __shownAt[`${id}-skeleton`] - __loadingAt[id];
  }, name);
}

/** The delay the slot's own stylesheet holds the skeleton hidden for, as computed. */
const loadingDelay = (page: Page, name: string) =>
  page.evaluate((id) => {
    const loading = document.querySelector(`fragment-slot[name="${id}"]`)?.shadowRoot?.querySelector('slot[name="loading"]');
    return loading ? getComputedStyle(loading).animationDelay : undefined;
  }, name);

describe('slot="loading"', () => {
  it('stays hidden for a fast moment, then shows while nothing of the fragment is on screen', async () => {
    const page = await open();
    await page.waitForSelector('fragment-slot[name="slow"][state="loading"]', { state: 'attached' });
    expect(await loadingDelay(page, 'slow')).toBe('0.2s');
    // it does show, and not before the delay; the lower bound leaves room for frame-time rounding
    expect(await shownAfter(page, 'slow')).toBeGreaterThanOrEqual(150);
    expect(await visible(page, '#slow-skeleton')).toBe(true);
    expect(await page.getAttribute('fragment-slot[name="slow"]', 'aria-busy')).toBe('true');

    release();
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
    // content is on screen, so the slot is no longer busy, though not yet ready
    expect(await page.getAttribute('fragment-slot[name="gated"]', 'aria-busy')).toBeNull();
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
    // it really is pierced: its content is there from the first sample
    expect(await page.evaluate(() => !!document.querySelector('fragment-slot[name="pierced"]')?.shadowRoot?.querySelector('#pierced-content'))).toBe(true);
    for (let i = 0; i < 10; i++) {
      expect(await visible(page, '#pierced-skeleton'), `sample ${i}`).toBe(false);
      expect(await page.getAttribute('fragment-slot[name="pierced"]', 'aria-busy'), `sample ${i}`).toBeNull();
      await page.waitForTimeout(100);
    }
    await page.close();
  });

  it('shows at once with --braid-loading-delay: 0s', async () => {
    const page = await open();
    await page.waitForSelector('fragment-slot[name="instant"][state="loading"]', { state: 'attached' });
    expect(await loadingDelay(page, 'instant')).toBe('0s');
    await shownAfter(page, 'instant');
    expect(await visible(page, '#instant-skeleton')).toBe(true);
    await page.close();
  });

  it("puts back a host's own aria-busy once loading is over", async () => {
    const page = await open();
    await page.waitForSelector('fragment-slot[name="hostbusy"][state="loading"]', { state: 'attached' });
    expect(await page.getAttribute('fragment-slot[name="hostbusy"]', 'aria-busy')).toBe('true');
    release();
    await page.waitForSelector('fragment-slot[name="hostbusy"]:is([state="ready"], [state="healthy"])', { state: 'attached', timeout: 10_000 });
    expect(await page.getAttribute('fragment-slot[name="hostbusy"]', 'aria-busy')).toBe('false');
    await page.close();
  });
});
