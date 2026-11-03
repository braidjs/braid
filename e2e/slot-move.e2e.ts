import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { endpoint, html, launch, readySlots, startHost, type Host } from './harness.js';

/**
 * A move is not an unmount: a slot a host reorders, reparents or relays out keeps its fragment
 * running — the same realm, the same state, no second fetch. Only a slot that actually leaves the
 * page closes.
 */

let browser: Browser;
let host: Host;
const documentFetches = new Map<string, number>();

/** A fragment that counts its clicks in its own realm, and fetches nothing else. */
function counter(id: string) {
  return {
    id,
    endpoint: endpoint((path) => {
      documentFetches.set(id, (documentFetches.get(id) ?? 0) + 1);
      void path;
      return html(
        `<button id="count">0</button><input id="field">` +
          `<script>let clicks = 0; document.getElementById('count').addEventListener('click', function () { clicks++; this.textContent = String(clicks); });</script>`,
      );
    }),
  };
}

beforeAll(async () => {
  browser = await launch();
  host = await startHost({
    gateway: {
      registry: [
        counter('moved'),
        counter('removed'),
        // pierced, so its button is on screen before it boots: the case an interaction gate holds for
        { ...counter('held'), pierce: ['/'], bound: false, src: '/' },
        counter('nested'),
        { id: 'parent', endpoint: endpoint(() => html('<div id="inner"></div>')) },
      ],
    },
    braidSource: `{ prerequisites: { hold: () => window.hold.then(() => 'ready') } }`,
    body:
      '<div id="a"><fragment-slot name="moved"></fragment-slot></div><div id="b"></div>' +
      '<fragment-slot name="removed"></fragment-slot>' +
      '<div id="c"><fragment-slot name="held" boot="interaction" requires="hold"></fragment-slot></div><div id="d"></div>' +
      '<fragment-slot name="parent"></fragment-slot><fragment-slot name="nested"></fragment-slot>' +
      `<script>
        window.hold = new Promise((resolve) => { window.release = resolve; });
        window.states = {};
        for (const slot of document.querySelectorAll('fragment-slot')) {
          slot.addEventListener('braid:state', (event) => {
            (window.states[slot.getAttribute('name')] ??= []).push(event.detail.state);
          });
        }
      </script>`,
  });
});

afterAll(async () => {
  await browser?.close();
  await host?.close();
});

const realmOf = (page: Page, id: string) =>
  page.evaluateHandle((name) => document.querySelector(`iframe[name="braid:${name}"]`), id);

const countIn = (page: Page, id: string) =>
  page.evaluate((name) => {
    const slot = document.querySelector(`fragment-slot[name="${name}"]`)!;
    return slot.shadowRoot!.querySelector('#count')!.textContent;
  }, id);

const clickIn = (page: Page, id: string) =>
  page.evaluate((name) => {
    const slot = document.querySelector(`fragment-slot[name="${name}"]`)!;
    (slot.shadowRoot!.querySelector('#count') as HTMLButtonElement).click();
  }, id);

describe('moving a slot', () => {
  it('keeps the fragment running: same realm, same state, no second fetch, no close', async () => {
    const page = await browser.newPage();
    await page.goto(host.url);
    await readySlots(page, 'moved');
    await clickIn(page, 'moved');
    expect(await countIn(page, 'moved')).toBe('1');
    const realm = await realmOf(page, 'moved');
    const fetchesBefore = documentFetches.get('moved');

    // an ordinary move: append a connected element somewhere else
    await page.evaluate(() => document.getElementById('b')!.append(document.querySelector('fragment-slot[name="moved"]')!));
    await page.waitForTimeout(300);

    expect(await page.evaluate(() => document.querySelector('#b > fragment-slot[name="moved"]') !== null)).toBe(true);
    expect(await page.evaluate((iframe) => iframe === document.querySelector('iframe[name="braid:moved"]') && iframe!.isConnected, realm)).toBe(
      true,
    );
    await clickIn(page, 'moved');
    expect(await countIn(page, 'moved')).toBe('2');
    expect(documentFetches.get('moved')).toBe(fetchesBefore);
    const states = await page.evaluate(() => (window as unknown as { states: Record<string, string[]> }).states.moved);
    expect(states).not.toContain('closing');
    expect(await page.getAttribute('fragment-slot[name="moved"]', 'state')).toMatch(/^(ready|healthy)$/);
    await page.close();
  });

  it('keeps focus inside the fragment through moveBefore', async () => {
    const page = await browser.newPage();
    await page.goto(host.url);
    await readySlots(page, 'moved');
    const supported = await page.evaluate(() => 'moveBefore' in Element.prototype);
    expect(supported, 'this Chromium has moveBefore').toBe(true);

    await page.evaluate(() => {
      const slot = document.querySelector('fragment-slot[name="moved"]')!;
      (slot.shadowRoot!.querySelector('#field') as HTMLInputElement).focus();
      const target = document.getElementById('b')! as Element & { moveBefore(node: Node, child: Node | null): void };
      target.moveBefore(slot, null);
    });
    await page.waitForTimeout(300);

    const focused = await page.evaluate(() => {
      const slot = document.querySelector('fragment-slot[name="moved"]')!;
      return document.activeElement === slot && slot.shadowRoot!.activeElement?.id === 'field';
    });
    expect(focused).toBe(true);
    const states = await page.evaluate(() => (window as unknown as { states: Record<string, string[]> }).states.moved);
    expect(states).not.toContain('closing');
    await page.close();
  });

  it('keeps clicks held by a boot gate, and replays them once the fragment boots', async () => {
    const page = await browser.newPage();
    await page.goto(host.url);
    await page.waitForFunction(() => customElements.get('fragment-slot') !== undefined);

    // the first interaction triggers the boot; the boot waits on the prerequisite, so the click is
    // still held when the slot moves
    await page.evaluate(() => {
      const slot = document.querySelector('fragment-slot[name="held"]')!;
      const button = slot.shadowRoot!.querySelector('#count')!;
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
      (button as HTMLButtonElement).click();
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => document.getElementById('d')!.append(document.querySelector('fragment-slot[name="held"]')!));
    await page.evaluate(() => (window as unknown as { release(): void }).release());

    await readySlots(page, 'held');
    await page.waitForFunction(
      () => document.querySelector('fragment-slot[name="held"]')!.shadowRoot!.querySelector('#count')!.textContent === '1',
      undefined,
      { timeout: 5_000 },
    );
    await page.close();
  });
});

describe('removing a slot', () => {
  it('still closes the fragment when the slot does not come back', async () => {
    const page = await browser.newPage();
    await page.goto(host.url);
    await readySlots(page, 'removed');
    await page.evaluate(() => document.querySelector('fragment-slot[name="removed"]')!.remove());
    await page.waitForFunction(
      () => ((window as unknown as { states: Record<string, string[]> }).states.removed ?? []).includes('closing'),
      undefined,
      { timeout: 5_000 },
    );
    await page.waitForFunction(() => document.querySelector('iframe[name="braid:removed"]') === null, undefined, { timeout: 5_000 });
    await page.close();
  });

  it('refuses a slot that brings its own code once it is moved into another fragment', async () => {
    const page = await browser.newPage();
    await page.goto(host.url);
    await readySlots(page, 'nested', 'parent');
    await page.evaluate(() => {
      const slot = document.querySelector('fragment-slot[name="nested"]')!;
      // an entry is code the host names; inside another fragment's DOM, that fragment named it
      slot.setAttribute('entry', '/nowhere.js');
      const inner = document.querySelector('fragment-slot[name="parent"]')!.shadowRoot!.querySelector('#inner')!;
      inner.append(slot);
    });
    await page.waitForFunction(
      () => document.querySelector('fragment-slot[name="parent"]')!.shadowRoot!.querySelector('fragment-slot[name="nested"][state="error"]'),
      undefined,
      { timeout: 5_000 },
    );
    await page.close();
  });
});
