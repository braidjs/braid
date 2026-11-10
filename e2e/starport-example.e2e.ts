import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launch } from './harness.js';
// the example itself, not a copy of it: what it documents is what this runs
import { bundle, loadGateway, start } from '../examples/starport/server.mjs';

/**
 * The Starport example (`examples/starport`) in Chromium: a console workspace around an FDC3
 * agent, with five static apps. What its README says it shows is what is checked here — a pick
 * followed across apps, an intent two apps can take, and a layout that brings an app's state back.
 */

const tsconfig = new URL('../tsconfig.base.json', import.meta.url).pathname;

let browser: Browser;
let server: { url: string; close(): Promise<void> };

beforeAll(async () => {
  browser = await launch();
  server = await start({ bundles: await bundle({ tsconfig }), gateway: await loadGateway({ tsconfig }) });
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** A fresh profile, so nothing is remembered from another test. */
async function desk(): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error('page error:', error.message));
  await page.goto(server.url);
  await ready(page);
  return page;
}

async function ready(page: Page) {
  await page.waitForSelector('html[data-ready]');
  await page.locator('main fragment-slot[name="flights"] tr[data-ship="NX-204"]').waitFor();
  await page.locator('main fragment-slot[name="cargo"] #manifest[data-loaded]').waitFor();
}

const app = (page: Page, id: string) => page.locator(`main fragment-slot[name="${id}"]`);
const open = (page: Page) => page.locator('main > fragment-slot').evaluateAll((slots) => slots.map((slot) => slot.getAttribute('name')));
const pick = (page: Page, registry: string) => app(page, 'flights').locator(`tr[data-ship="${registry}"]`).click();

describe('the Starport example', () => {
  it('boots its starting apps, and a ship picked in one is followed by the others', async () => {
    const page = await desk();
    expect(await open(page)).toEqual(['flights', 'star-map', 'cargo']);

    await pick(page, 'NX-204');
    await expect.poll(() => app(page, 'star-map').locator('#status').textContent()).toBe('Marigold is between Ceres and Europa.');
    await expect.poll(() => app(page, 'cargo').locator('#title').textContent()).toBe('Manifest · Marigold (NX-204)');
    expect(await app(page, 'cargo').locator('#items tr').count()).toBe(3);
    await page.context().close();
  });

  it('asks which app takes an intent two can, remembers the answer, and launches an app for a raise', async () => {
    const page = await desk();
    await pick(page, 'NX-204');
    await app(page, 'flights').locator('#plot').click();

    // Star Map is open and Radar is not: both are offered
    const chooser = page.locator('#chooser');
    await chooser.waitFor({ state: 'visible' });
    expect(await chooser.locator('#chooser-list button').evaluateAll((buttons) => buttons.map((b) => [(b as HTMLElement).dataset.app, b.querySelector('.state')?.textContent]))).toEqual([
      ['star-map', 'open'],
      ['radar', 'will launch'],
    ]);
    await chooser.locator('#chooser-remember').check();
    await chooser.locator('button[data-app="radar"]').click();

    // Radar was launched for the raise, and got it
    await expect.poll(() => app(page, 'radar').locator('#status').textContent()).toContain('Locked on Marigold');
    expect(await open(page)).toEqual(['flights', 'star-map', 'cargo', 'radar']);
    expect(await app(page, 'star-map').locator('#status').textContent()).not.toContain('Course plotted');
    await expect.poll(() => page.locator('#remembered').textContent()).toContain('Radar');

    // the next raise is not asked about
    await pick(page, 'KT-077');
    await app(page, 'flights').locator('#plot').click();
    await expect.poll(() => app(page, 'radar').locator('#status').textContent()).toContain('Locked on Slow Comet');
    expect(await chooser.isVisible()).toBe(false);

    // forgotten, it is asked again
    await page.locator('#forget').click();
    await app(page, 'flights').locator('#plot').click();
    await chooser.waitFor({ state: 'visible' });
    await chooser.locator('button[data-app="star-map"]').click();
    await expect.poll(() => app(page, 'star-map').locator('#status').textContent()).toBe('Course plotted for Slow Comet: Titan → Mars');

    // only Comms takes HailShip, so nothing is asked: it is launched
    await app(page, 'flights').locator('#hail').click();
    await expect.poll(() => app(page, 'comms').locator('#status').textContent()).toBe('Channel open with Slow Comet.');
    expect(await chooser.isVisible()).toBe(false);
    await page.context().close();
  });

  it('saves a layout and restores it with each app\'s own state, after a reload too', async () => {
    const page = await desk();
    await app(page, 'star-map').locator('#in').click();
    expect(await app(page, 'star-map').locator('#zoom-label').textContent()).toBe('Zoom 2×');
    await app(page, 'cargo').locator('#col-hazard').uncheck();
    await app(page, 'cargo').locator('#manifest[data-saved="mass"]').waitFor();
    await page.locator('#dock button[data-launch="radar"]').click();
    await app(page, 'radar').locator('#status').waitFor();

    await page.locator('#layout-name').fill('night shift');
    await page.locator('#save-layout button').click();
    await page.locator('#layouts button[data-restore="night shift"]').waitFor();

    // close two apps with the desk's ×
    for (const id of ['star-map', 'radar']) {
      await app(page, id).hover();
      await page.locator('#close-tile').click();
    }
    expect(await open(page)).toEqual(['flights', 'cargo']);

    await page.locator('#layouts button[data-restore="night shift"]').click();
    await expect.poll(() => open(page)).toEqual(['flights', 'star-map', 'cargo', 'radar']);
    await expect.poll(() => app(page, 'star-map').locator('#zoom-label').textContent()).toBe('Zoom 2×');

    // a reload shows the desk as designed; the layout and the app's setting are still the user's
    await page.reload();
    await ready(page);
    expect(await open(page)).toEqual(['flights', 'star-map', 'cargo']);
    expect(await app(page, 'star-map').locator('#zoom-label').textContent()).toBe('Zoom 1×');
    expect(await app(page, 'cargo').locator('#col-hazard').isChecked()).toBe(false);
    await page.locator('#layouts button[data-restore="night shift"]').click();
    await expect.poll(() => open(page)).toEqual(['flights', 'star-map', 'cargo', 'radar']);
    await expect.poll(() => app(page, 'star-map').locator('#zoom-label').textContent()).toBe('Zoom 2×');
    await page.context().close();
  });
});
