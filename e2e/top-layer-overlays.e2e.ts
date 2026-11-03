import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { endpoint, html, launch, readySlots, startHost, type Host } from './harness.js';

/**
 * A fragment's modal, portaled to `document.body` the way UI libraries do, inside a host container
 * that clips (overflow hidden) and contains fixed descendants (a transform). In the fragment's
 * compat realm, `document.body` is the fragment's own body, inside the slot — so the modal is
 * trapped in the host's box. With `overlays="top-layer"` the slot lifts what the fragment portals
 * to its body into the browser's top layer, still inside the fragment's own tree.
 */

let browser: Browser;
let host: Host;

/** Opens a full-viewport modal on click, appended to the body as a portal would be, with a button far outside the host's box. */
const dialogs = (id: string) =>
  html(
    // the style after the button: a snippet's leading <style> is hoisted into a head the client drops
    `<button id="open">open</button>` +
      `<style>.inside { position: absolute; top: 400px; left: 400px; width: 120px; height: 40px; color: rgb(1, 2, 3); }</style>` +
      `<script>
        document.getElementById('open').addEventListener('click', () => {
          const modal = document.createElement('div');
          modal.id = 'modal';
          modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;';
          const inside = document.createElement('button');
          inside.id = 'inside';
          inside.className = 'inside';
          inside.textContent = 'inside';
          inside.addEventListener('click', () => { modal.dataset.clicked = ${JSON.stringify(id)}; });
          modal.append(inside);
          document.body.appendChild(modal);
        });
      </script>`,
  );

beforeAll(async () => {
  browser = await launch();
  host = await startHost({
    gateway: {
      registry: [
        { id: 'clipped', endpoint: endpoint(() => dialogs('clipped')) },
        { id: 'lifted', endpoint: endpoint(() => dialogs('lifted')) },
      ],
    },
    head: '<style>.frame { width: 300px; height: 80px; overflow: hidden; transform: translateZ(0); }</style>',
    body:
      '<div class="frame" id="clipped-frame"><fragment-slot name="clipped"></fragment-slot></div>' +
      '<div class="frame" id="lifted-frame"><fragment-slot name="lifted" overlays="top-layer"></fragment-slot></div>',
  });
});

afterAll(async () => {
  await browser?.close();
  await host?.close();
});

async function openModal(page: Page, slot: string) {
  await page.evaluate((name) => {
    (document.querySelector(`fragment-slot[name="${name}"]`)!.shadowRoot!.querySelector('#open') as HTMLButtonElement).click();
  }, slot);
  await page.waitForFunction(
    (name) => document.querySelector(`fragment-slot[name="${name}"]`)!.shadowRoot!.querySelector('#modal'),
    slot,
  );
  await page.waitForTimeout(100);
}

const clickedIn = (page: Page, slot: string) =>
  page.evaluate(
    (name) => (document.querySelector(`fragment-slot[name="${name}"]`)!.shadowRoot!.querySelector('#modal') as HTMLElement).dataset['clicked'] ?? null,
    slot,
  );

describe('a fragment’s modal in a clipping host container', () => {
  it('is trapped in the host’s box without the opt-in (the problem)', async () => {
    const page = await browser.newPage();
    await page.goto(host.url);
    await readySlots(page, 'clipped');
    await openModal(page, 'clipped');

    await page.mouse.click(460, 420);
    expect(await clickedIn(page, 'clipped')).toBeNull();
    await page.close();
  });

  it('is lifted into the top layer with overlays="top-layer", still inside the fragment', async () => {
    const page = await browser.newPage();
    await page.goto(host.url);
    await readySlots(page, 'lifted');
    await openModal(page, 'lifted');

    const modal = await page.evaluate(() => {
      const shadow = document.querySelector('fragment-slot[name="lifted"]')!.shadowRoot!;
      const element = shadow.querySelector('#modal') as HTMLElement;
      return {
        open: element.matches(':popover-open'),
        // the boundary answers getRootNode for fragment nodes with the realm document; the native one tells
        inShadow: Node.prototype.getRootNode.call(element) === shadow,
        // the fragment's own stylesheet still reaches it
        color: getComputedStyle(shadow.querySelector('#inside')!).color,
      };
    });
    expect(modal).toEqual({ open: true, inShadow: true, color: 'rgb(1, 2, 3)' });

    // a real click, outside the host's box: it lands on the modal's button, whose handler runs
    await page.mouse.click(460, 420);
    expect(await clickedIn(page, 'lifted')).toBe('lifted');

    // and the modal goes when the fragment removes it
    await page.evaluate(() => document.querySelector('fragment-slot[name="lifted"]')!.shadowRoot!.querySelector('#modal')!.remove());
    expect(await page.evaluate(() => document.querySelector('fragment-slot[name="lifted"]')!.shadowRoot!.querySelector(':popover-open'))).toBeNull();
    await page.close();
  });
});
