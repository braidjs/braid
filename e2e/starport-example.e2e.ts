import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launch } from './harness.js';
// the example itself, not a copy of it: what it documents is what this runs
import { build } from '../examples/starport/build.mjs';
import { start } from '../examples/starport/server.mjs';

/**
 * The Starport example (`examples/starport`) in Chromium, as it is deployed: a folder of static
 * files under a path, behind a server that has never heard of Braid. The gateway is the page's
 * service worker. What the README says the desk shows is what is checked here.
 */

const tsconfig = new URL('../tsconfig.base.json', import.meta.url).pathname;

let browser: Browser;
let server: { url: string; close(): Promise<void> };
let dir: string;
const requested: string[] = [];

beforeAll(async () => {
  browser = await launch();
  dir = await mkdtemp(join(tmpdir(), 'starport-e2e-'));
  await build({ out: dir, tsconfig });
  server = await start({ dir, base: '/starport/', onRequest: (path) => requested.push(path) });
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
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
  // the map's markup is there before its script has run; its ports are drawn by the script
  await page.locator('main fragment-slot[name="star-map"] #ports .port').first().waitFor();
}

const app = (page: Page, id: string) => page.locator(`main fragment-slot[name="${id}"]`);
const open = (page: Page) => page.locator('main > fragment-slot').evaluateAll((slots) => slots.map((slot) => slot.getAttribute('name')));
const pick = (page: Page, registry: string) => app(page, 'flights').locator(`tr[data-ship="${registry}"]`).click();

describe('the Starport example', () => {
  it('is served as static files under a path, with the gateway in the service worker', async () => {
    const page = await desk();
    expect(new URL(page.url()).pathname).toBe('/starport/');
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(`${server.url}sw.js`);
    expect(await open(page)).toEqual(['flights', 'star-map', 'cargo']);
    // the server was asked for files, and never for anything in Braid's namespace
    expect(requested).toContain('/starport/apps/flights/index.html');
    expect(requested.filter((path) => path.includes('/__braid/'))).toEqual([]);
    // and the page did use that namespace, under the desk's own path: the worker answered it
    const braid = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => new URL(entry.name).pathname).filter((path) => path.includes('/__braid/')));
    expect(braid.length).toBeGreaterThan(0);
    expect(braid.every((path) => path.startsWith('/starport/__braid/'))).toBe(true);
    await page.context().close();
  });

  it('boots its starting apps, and a ship picked in one is followed by the others', async () => {
    const page = await desk();
    expect(await open(page)).toEqual(['flights', 'star-map', 'cargo']);

    // by keyboard, as by pointer: the board shows its own pick and enables what acts on it
    expect(await app(page, 'flights').locator('#plot').isDisabled()).toBe(true);
    await app(page, 'flights').locator('tr[data-ship="NX-204"]').focus();
    await page.keyboard.press('Enter');
    expect(await app(page, 'flights').locator('#picked').textContent()).toBe('Marigold selected');
    expect(await app(page, 'flights').locator('#plot').isDisabled()).toBe(false);
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
    expect(await page.locator('#remembered').isVisible()).toBe(true);

    // the next raise is not asked about
    await pick(page, 'KT-077');
    await app(page, 'flights').locator('#plot').click();
    await expect.poll(() => app(page, 'radar').locator('#status').textContent()).toContain('Locked on Slow Comet');
    expect(await chooser.isVisible()).toBe(false);
    // and Star Map, which was not chosen either time, never plotted a course
    expect(await app(page, 'star-map').locator('#status').textContent()).toBe('Slow Comet is between Titan and Mars.');

    // forgotten, it is asked again
    await page.locator('#forget').click();
    await app(page, 'flights').locator('#plot').click();
    await chooser.waitFor({ state: 'visible' });
    await chooser.locator('button[data-app="star-map"]').click();
    await expect.poll(() => app(page, 'star-map').locator('#status').textContent()).toBe('Course plotted for Slow Comet: Titan → Mars');
    // that choice was not ticked, so it was not remembered: the next raise asks again
    await app(page, 'flights').locator('#plot').click();
    await chooser.waitFor({ state: 'visible' });
    expect(await page.locator('#remembered').isVisible()).toBe(false);
    await chooser.locator('#chooser-cancel').click();

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
    await page.locator('#dock [data-app="radar"] .launch').click();
    await app(page, 'radar').locator('#status').waitFor();

    await page.locator('#layout-name').fill('night shift');
    await page.locator('#save-layout button').click();
    await page.locator('#layouts button[data-restore="night shift"]').waitFor();

    // close two apps from the dock
    for (const id of ['star-map', 'radar']) await page.locator(`#dock [data-app="${id}"] .close`).click();
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

  it('announces a departure on the event bus: heard once by who was listening, counted for who comes later', async () => {
    const page = await desk();
    await page.locator('#dock [data-app="comms"] .launch').click();
    await app(page, 'comms').locator('#send').waitFor();
    expect(await page.locator('#ticker').isVisible()).toBe(false);

    await pick(page, 'NX-204');
    await app(page, 'flights').locator('#depart').click();
    await expect.poll(() => page.locator('#ticker-event').textContent()).toBe('Marigold departed for Europa');
    await expect.poll(() => page.locator('#ticker-count').textContent()).toBe('1 departure today');
    await expect.poll(() => app(page, 'comms').locator('#log').textContent()).toContain('Tower: Marigold departed for Europa.');
    expect(await app(page, 'flights').locator('tr[data-ship="NX-204"] .pill').textContent()).toBe('Departed');
    expect(await app(page, 'flights').locator('#depart').isDisabled()).toBe(true);

    // a second Comms, opened afterwards: the count is state and reaches it, the event is not replayed
    await page.locator('#dock [data-app="comms"] .launch').click();
    const late = app(page, 'comms').nth(1);
    await expect.poll(() => late.locator('#tower').textContent()).toBe('1 departure today');
    expect(await late.locator('#log').textContent()).not.toContain('Marigold');

    // and the next departure reaches both
    await pick(page, 'KT-077');
    await app(page, 'flights').locator('#depart').click();
    await expect.poll(() => late.locator('#log').textContent()).toContain('Tower: Slow Comet departed for Mars.');
    await expect.poll(() => page.locator('#ticker-count').textContent()).toBe('2 departures today');
    await page.context().close();
  });

  it('shows what the desk and the apps do not share, checked against the page', async () => {
    const page = await desk();
    await page.locator('#open-boundaries').click();
    const facts = page.locator('#boundary-facts li');
    expect(await facts.evaluateAll((items) => items.map((item) => [item.querySelector('b')?.textContent, (item as HTMLElement).dataset.holds]))).toEqual([
      ['Globals', 'true'],
      ['Element ids', 'true'],
      ['Styles', 'true'],
    ]);
    expect(await facts.nth(1).textContent()).toContain('1 open app has an element with id="status"');
    // with Radar open there are two with that id, and still no collision
    await page.locator('#boundaries .done').click();
    await page.locator('#dock [data-app="radar"] .launch').click();
    await app(page, 'radar').locator('#status').waitFor();
    await page.locator('#open-boundaries').click();
    expect(await facts.evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.holds))).toEqual(['true', 'true', 'true']);
    expect(await facts.nth(1).textContent()).toContain('2 open apps each have an element with id="status"');
    expect(await facts.nth(2).textContent()).toContain('4 open apps use class="app", and 0 of them are hidden');
    // the claims are the page's: the apps really are visible, and really do hold those ids
    expect(await app(page, 'radar').locator('.app').isVisible()).toBe(true);
    expect(await page.evaluate(() => document.getElementById('status'))).toBeNull();
    await page.context().close();
  });

  it('never offers an app the user has hidden, after a reload too', async () => {
    const page = await desk();
    await page.locator('#open-preferences').click();
    await page.locator('#preferences [data-hide="radar"]').check();
    await page.locator('#hidden-apps[data-saved="radar"]').waitFor();
    await page.locator('#preferences .done').click();

    // Radar is hidden, so one app is left that can take Plot route: nothing is asked
    await pick(page, 'NX-204');
    await app(page, 'flights').locator('#plot').click();
    await expect.poll(() => app(page, 'star-map').locator('#status').textContent()).toBe('Course plotted for Marigold: Ceres → Europa');
    expect(await page.locator('#chooser').isVisible()).toBe(false);
    expect(await open(page)).toEqual(['flights', 'star-map', 'cargo']);

    await page.reload();
    await ready(page);
    await page.locator('#open-preferences').click();
    expect(await page.locator('#preferences [data-hide="radar"]').isChecked()).toBe(true);
    await page.locator('#preferences .done').click();
    await pick(page, 'KT-077');
    await app(page, 'flights').locator('#plot').click();
    await expect.poll(() => app(page, 'star-map').locator('#status').textContent()).toBe('Course plotted for Slow Comet: Titan → Mars');
    expect(await page.locator('#chooser').isVisible()).toBe(false);
    await page.context().close();
  });
});
