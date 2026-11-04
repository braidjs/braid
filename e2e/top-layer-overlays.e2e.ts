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

/**
 * A fragment that portals to its body the ways libraries do: a full-viewport modal it reuses (one
 * element, appended and removed), a toast anchored bottom-right, and a native dialog.
 */
const portals = () =>
  html(
    // the style after the buttons: a snippet's leading <style> is hoisted into a head the client drops
    `<button id="open">open</button><button id="close">close</button><button id="toast">toast</button><button id="dialog">dialog</button><button id="layered">layered</button>` +
      `<style>.inside { position: absolute; top: 400px; left: 400px; width: 120px; height: 40px; color: rgb(1, 2, 3); }` +
      `.toast { position: fixed; right: 16px; bottom: 16px; width: 100px; height: 30px; }` +
      // a library's styles in a cascade layer, as Tailwind v4's utilities are
      `@layer ui { .layered-modal { position: fixed; inset: 0; background: rgb(0, 0, 0); padding: 20px; border: 3px solid; } }</style>` +
      `<script>
        const modal = document.createElement('div');
        modal.id = 'modal';
        modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;';
        const inside = document.createElement('button');
        inside.id = 'inside';
        inside.className = 'inside';
        inside.textContent = 'inside';
        inside.addEventListener('click', () => { modal.dataset.clicked = String(Number(modal.dataset.clicked ?? 0) + 1); });
        modal.append(inside);
        document.getElementById('open').addEventListener('click', () => document.body.appendChild(modal));
        document.getElementById('close').addEventListener('click', () => modal.remove());
        document.getElementById('toast').addEventListener('click', () => {
          const toast = document.createElement('div');
          toast.id = 'toast-box';
          toast.className = 'toast';
          document.body.appendChild(toast);
        });
        document.getElementById('layered').addEventListener('click', () => {
          const layered = document.createElement('div');
          layered.id = 'layered-modal';
          layered.className = 'layered-modal';
          document.body.appendChild(layered);
        });
        document.getElementById('dialog').addEventListener('click', () => {
          const dialog = document.createElement('dialog');
          dialog.id = 'native-dialog';
          dialog.textContent = 'native';
          document.body.appendChild(dialog);
          setTimeout(() => {
            try { dialog.showModal(); dialog.dataset.outcome = 'open'; } catch (error) { dialog.dataset.outcome = error.name; }
          }, 50);
        });
      </script>`,
  );

beforeAll(async () => {
  browser = await launch();
  host = await startHost({
    gateway: {
      registry: [
        { id: 'clipped', endpoint: endpoint(portals) },
        { id: 'lifted', endpoint: endpoint(portals) },
        // server-rendered into the page: the gateway writes the slot's stylesheet, not the client
        { id: 'pierced', pierce: ['/pierced'], bound: false, src: '/', endpoint: endpoint(portals) },
      ],
    },
    pages: ['/pierced'],
    head: '<style>.frame { width: 300px; height: 80px; overflow: hidden; transform: translateZ(0); }</style>',
    body:
      '<div class="frame"><fragment-slot name="clipped"></fragment-slot></div>' +
      '<div class="frame"><fragment-slot name="lifted" overlays="top-layer"></fragment-slot></div>' +
      '<div class="frame"><fragment-slot name="pierced" overlays="top-layer"></fragment-slot></div>',
  });
});

afterAll(async () => {
  await browser?.close();
  await host?.close();
});

const press = (page: Page, slot: string, button: string) =>
  page.evaluate(
    ([name, id]) => (document.querySelector(`fragment-slot[name="${name}"]`)!.shadowRoot!.querySelector(`#${id}`) as HTMLButtonElement).click(),
    [slot, button] as const,
  );

/** Reads a fact about an element in a slot's shadow root. */
const read = (page: Page, slot: string, selector: string, fact: string) =>
  page.evaluate(
    ([name, query, what]) => {
      const shadow = document.querySelector(`fragment-slot[name="${name}"]`)!.shadowRoot!;
      const element = shadow.querySelector(query) as HTMLElement | null;
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const facts: Record<string, unknown> = {
        open: element.matches(':popover-open'),
        modal: element.matches(':modal'),
        popover: element.hasAttribute('popover'),
        // the boundary answers getRootNode for fragment nodes with the realm document; the native one tells
        inShadow: Node.prototype.getRootNode.call(element) === shadow,
        clicked: element.dataset['clicked'] ?? null,
        outcome: element.dataset['outcome'] ?? null,
        color: style.color,
        border: style.borderTopWidth,
        padding: style.paddingTop,
        position: style.position,
        background: style.backgroundColor,
        box: { right: Math.round(rect.right), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) },
        left: Math.round(rect.left),
      };
      return facts[what];
    },
    [slot, selector, fact] as const,
  );

describe('a fragment’s portals in a clipping host container', () => {
  it('are trapped in the host’s box without the opt-in (the problem)', async () => {
    const page = await browser.newPage();
    await page.goto(host.url);
    await readySlots(page, 'clipped');
    await press(page, 'clipped', 'open');
    await page.waitForTimeout(100);

    await page.mouse.click(460, 420);
    expect(await read(page, 'clipped', '#modal', 'clicked')).toBeNull();
    await page.close();
  });

  it('are lifted into the top layer with overlays="top-layer", still in the fragment, and again when reused', async () => {
    const page = await browser.newPage();
    await page.goto(host.url);
    await readySlots(page, 'lifted');
    await press(page, 'lifted', 'open');
    await page.waitForTimeout(100);

    expect(await read(page, 'lifted', '#modal', 'open')).toBe(true);
    expect(await read(page, 'lifted', '#modal', 'inShadow')).toBe(true);
    expect(await read(page, 'lifted', '#inside', 'color')).toBe('rgb(1, 2, 3)');

    // a real click, outside the host's box: it lands on the modal's button, whose handler runs
    await page.mouse.click(460, 420);
    expect(await read(page, 'lifted', '#modal', 'clicked')).toBe('1');

    // closed by the fragment, then opened again with the same element, as libraries reuse a portal
    await press(page, 'lifted', 'close');
    await page.waitForTimeout(50);
    await press(page, 'lifted', 'open');
    await page.waitForTimeout(100);
    expect(await read(page, 'lifted', '#modal', 'open')).toBe(true);
    await page.mouse.click(460, 420);
    expect(await read(page, 'lifted', '#modal', 'clicked')).toBe('2');
    await page.close();
  });

  it('keep a portal anchored bottom-right where it was anchored, at its own size', async () => {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(host.url);
    await readySlots(page, 'lifted');
    await press(page, 'lifted', 'toast');
    await page.waitForTimeout(100);

    expect(await read(page, 'lifted', '#toast-box', 'box')).toEqual({ right: 1000 - 16, bottom: 700 - 16, width: 100, height: 30 });
    await page.close();
  });

  it('keep a library’s own layered styles: the reset loses to every layer of the fragment’s', async () => {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(host.url);
    await readySlots(page, 'lifted');
    await press(page, 'lifted', 'layered');
    await page.waitForTimeout(100);

    expect(await read(page, 'lifted', '#layered-modal', 'open')).toBe(true);
    expect(await read(page, 'lifted', '#layered-modal', 'position')).toBe('fixed');
    expect(await read(page, 'lifted', '#layered-modal', 'background')).toBe('rgb(0, 0, 0)');
    expect(await read(page, 'lifted', '#layered-modal', 'padding')).toBe('20px');
    expect(await read(page, 'lifted', '#layered-modal', 'border')).toBe('3px');
    expect(await read(page, 'lifted', '#layered-modal', 'box')).toMatchObject({ width: 1000, height: 700 });
    await page.close();
  });

  it('leave a native dialog to its own showModal', async () => {
    const page = await browser.newPage();
    await page.goto(host.url);
    await readySlots(page, 'lifted');
    await press(page, 'lifted', 'dialog');
    await page.waitForFunction(() =>
      (document.querySelector('fragment-slot[name="lifted"]')!.shadowRoot!.querySelector('#native-dialog') as HTMLElement | null)?.dataset['outcome'],
    );

    expect(await read(page, 'lifted', '#native-dialog', 'outcome')).toBe('open');
    expect(await read(page, 'lifted', '#native-dialog', 'modal')).toBe(true);
    expect(await read(page, 'lifted', '#native-dialog', 'popover')).toBe(false);
    // centred by the browser, not pinned to the corner
    expect(await read(page, 'lifted', '#native-dialog', 'left')).toBeGreaterThan(0);
    await page.close();
  });

  it('are lifted from a server-rendered (pierced) slot with the same reset', async () => {
    const page = await browser.newPage();
    await page.goto(`${host.url}pierced`);
    await readySlots(page, 'pierced');
    await press(page, 'pierced', 'open');
    await page.waitForTimeout(100);

    expect(await read(page, 'pierced', '#modal', 'open')).toBe(true);
    expect(await read(page, 'pierced', '#modal', 'border')).toBe('0px');
    expect(await read(page, 'pierced', '#modal', 'padding')).toBe('0px');
    await page.mouse.click(460, 420);
    expect(await read(page, 'pierced', '#modal', 'clicked')).toBe('1');
    await page.close();
  });
});
