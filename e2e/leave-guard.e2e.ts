import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { endpoint, launch, readySlots, startHost, type Host } from './harness.js';

/**
 * `initBraid({ confirmLeave })` with the Navigation API: a link to another document on this origin
 * waits while a fragment holds unsaved work, and goes once the host's question is answered yes.
 */

let browser: Browser;
let host: Host;

beforeAll(async () => {
  browser = await launch();
  host = await startHost({
    gateway: {
      registry: [
        {
          id: 'editor',
          endpoint: endpoint(
            () =>
              new Response(`globalThis.__braidFragment = { mount(env) { env.setDirty('editing an invoice'); } };`, {
                headers: { 'content-type': 'text/javascript' },
              }),
          ),
        },
      ],
    },
    pages: ['/elsewhere'],
    braidSource: `{ confirmLeave: (slots) => {
      window.asked = slots.map((slot) => slot.getAttribute('name') + ': ' + slot.dirty);
      return new Promise((resolve) => setTimeout(() => resolve(window.answer), 50));
    } }`,
    body:
      '<a id="away" href="/elsewhere">elsewhere</a>' +
      '<fragment-slot name="editor" adapter="contract" entry="/__braid/frag/editor/entry.js"></fragment-slot>',
  });
});

afterAll(async () => {
  await browser?.close();
  await host?.close();
});

describe('leaving with unsaved work', () => {
  it('asks first, and stays when the answer is no', async () => {
    const page = await browser.newPage();
    await page.goto(host.url);
    await readySlots(page, 'editor');
    await page.waitForFunction(() => (document.querySelector('fragment-slot[name="editor"]') as HTMLElement & { dirty: string | null }).dirty !== null);
    await page.evaluate(() => ((window as unknown as { answer: boolean }).answer = false));

    await page.click('#away');
    await page.waitForFunction(() => (window as unknown as { asked?: string[] }).asked !== undefined);
    await page.waitForTimeout(300);

    expect(new URL(page.url()).pathname).toBe('/');
    expect(await page.evaluate(() => (window as unknown as { asked: string[] }).asked)).toEqual(['editor: editing an invoice']);
    // the page is the same one: no reload happened
    expect(await page.evaluate(() => (window as unknown as { answer: boolean }).answer)).toBe(false);
    await page.close();
  });

  it('goes once the answer is yes', async () => {
    const page = await browser.newPage();
    await page.goto(host.url);
    await readySlots(page, 'editor');
    await page.waitForFunction(() => (document.querySelector('fragment-slot[name="editor"]') as HTMLElement & { dirty: string | null }).dirty !== null);
    await page.evaluate(() => ((window as unknown as { answer: boolean }).answer = true));

    await page.click('#away');
    await page.waitForURL(/\/elsewhere$/, { timeout: 5_000 });
    await page.close();
  });
});
