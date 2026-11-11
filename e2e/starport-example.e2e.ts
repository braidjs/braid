import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
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
  // reduced motion: a tile animates in at 97% of its size, which a measurement could catch
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
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

/** Sends one raw request line, as a browser would for a URL such as `http://host//`. */
function rawGet(url: string, target: string): Promise<string> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => socket.write(`GET ${target} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`));
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data.split('\r\n')[0]));
    socket.on('error', reject);
  });
}

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
    expect(await page.locator('#ticker-count').textContent()).toBe('0 departures today');

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
    await expect.poll(() => app(page, 'comms').first().locator('#log').textContent()).toContain('Tower: Slow Comet departed for Mars.');
    await expect.poll(() => page.locator('#ticker-count').textContent()).toBe('2 departures today');

    // which ships have left is state too: a Flights opened afresh shows them, and counts on from there
    await page.locator('#dock [data-app="flights"] .close').click();
    await page.locator('#dock [data-app="flights"] .launch').click();
    await expect.poll(() => app(page, 'flights').locator('tr[data-ship="NX-204"] .pill').textContent()).toBe('Departed');
    await pick(page, 'NX-204');
    expect(await app(page, 'flights').locator('#depart').isDisabled()).toBe(true);
    await pick(page, 'PL-311');
    await app(page, 'flights').locator('#depart').click();
    await expect.poll(() => page.locator('#ticker-count').textContent()).toBe('3 departures today');
    await page.context().close();
  });

  it('shows what the desk and the apps do not share, checked against the page', async () => {
    const page = await desk();
    await page.locator('#open-boundaries').click();
    const facts = page.locator('#boundary-facts li');
    expect(await facts.evaluateAll((items) => items.map((item) => [item.querySelector('b')?.textContent, (item as HTMLElement).dataset.holds]))).toEqual([
      ['Globals: holds', 'true'],
      ['Element ids: holds', 'true'],
      ['Styles: holds', 'true'],
    ]);
    // the global is real: Flights' realm has it, as the panel says, and the desk's window does not
    expect(await facts.nth(0).textContent()).toContain('1 realm on this page has one');
    const withShips = await Promise.all(page.frames().map((frame) => frame.evaluate(() => Array.isArray((window as unknown as { SHIPS?: unknown }).SHIPS)).catch(() => false)));
    expect(withShips.filter(Boolean).length).toBe(1);
    expect(await page.evaluate(() => 'SHIPS' in window)).toBe(false);
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
    // hiding the last app that can take the intent would cancel every raise, so it cannot be ticked
    expect(await page.locator('#preferences [data-hide="star-map"]').isDisabled()).toBe(true);
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

  it('fits a phone: nothing wider than the screen, and the Boundaries panel opens at its start, in view', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    const page = await context.newPage();
    await page.goto(server.url);
    await ready(page);
    // a page wider than the screen is what put the panel off to one side
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    for (const id of ['flights', 'star-map', 'cargo']) {
      const box = await app(page, id).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }

    await page.locator('#open-boundaries').click();
    const panel = await page.locator('#boundaries').boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(390);
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(664);
    const title = await page.locator('#boundaries-title').boundingBox();
    expect(title!.y).toBeGreaterThanOrEqual(panel!.y);
    expect(await page.locator('#boundary-facts li').count()).toBe(3);
    expect(await page.locator('#boundary-facts li').first().isVisible()).toBe(true);
    // the rest is reached by scrolling the panel, not the page
    await page.locator('#boundaries .done').scrollIntoViewIfNeeded();
    await page.locator('#boundaries .done').click();
    expect(await page.locator('#boundaries').isVisible()).toBe(false);
    await context.close();
  });

  it('answers a request-target that is not a URL with a 400, and keeps serving', async () => {
    // `//` throws from `new URL`; uncaught, that took the whole server down, and any page can
    // make a browser send it
    expect(await rawGet(server.url, '//')).toBe('HTTP/1.1 400 Bad Request');
    expect((await fetch(server.url)).status).toBe(200);
  });

  it('shows the seams: every tile outlined and labelled with its slot, its state and where the worker served it', async () => {
    const page = await desk();
    const seam = app(page, 'star-map').locator('.braid-tile-head .seam');
    expect(await seam.isVisible()).toBe(false);
    await page.locator('#seams-toggle').click();
    expect(await page.locator('#seams-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(await seam.isVisible()).toBe(true);
    expect(await seam.textContent()).toBe('<fragment-slot name="star-map">  ·  healthy  ·  own realm  ·  /starport/__braid/frag/star-map/');
    expect(await page.locator('main > fragment-slot .braid-tile-head .seam:visible').count()).toBe(3);
    expect(await app(page, 'flights').evaluate((slot) => getComputedStyle(slot).outlineStyle)).toBe('dashed');
    // the header is above the app's own content, not after it
    const headerBottom = (await app(page, 'star-map').locator('.braid-tile-head').boundingBox())!;
    const appTop = (await app(page, 'star-map').locator('h2').boundingBox())!;
    expect(headerBottom.y + headerBottom.height).toBeLessThanOrEqual(appTop.y);

    // the label follows Braid's state for the slot as it changes
    await app(page, 'star-map').evaluate((slot) => slot.setAttribute('state', 'suspect'));
    await expect.poll(() => seam.textContent()).toContain('·  suspect  ·');
    // and a tile that arrives later is labelled through its boot
    await page.locator('#dock [data-app="radar"] .launch').click();
    await expect.poll(() => app(page, 'radar').locator('.braid-tile-head .seam').textContent()).toBe('<fragment-slot name="radar">  ·  healthy  ·  own realm  ·  /starport/__braid/frag/radar/');

    await page.locator('#seams-toggle').click();
    expect(await seam.isVisible()).toBe(false);
    expect(await app(page, 'flights').evaluate((slot) => getComputedStyle(slot).outlineStyle)).toBe('none');
    await page.context().close();
  });

  it('moves a tile by dragging its grip, by touch, or with Alt and an arrow key, and the app keeps running', async () => {
    const page = await desk();
    await app(page, 'star-map').locator('#in').click();
    expect(await app(page, 'star-map').locator('#zoom-label').textContent()).toBe('Zoom 2×');
    // a mark left in Star Map's own realm: a remount would be a new realm, without it
    const realmOf = () => page.frames().find((frame) => frame.name() === 'braid:star-map');
    await realmOf()!.evaluate(() => ((window as unknown as { marked: boolean }).marked = true));
    const stillMarked = async () => realmOf()?.evaluate(() => (window as unknown as { marked?: boolean }).marked === true) ?? false;

    // a mouse drag onto Flights puts Star Map in its place
    const grip = await app(page, 'star-map').locator('.braid-tile-grip').boundingBox();
    const flights = await app(page, 'flights').boundingBox();
    await page.mouse.move(grip!.x + 5, grip!.y + 5);
    await page.mouse.down();
    await page.mouse.move(flights!.x + 80, flights!.y + 160, { steps: 8 });
    await page.mouse.up();
    expect(await open(page)).toEqual(['star-map', 'flights', 'cargo']);
    // the same app, not a new one: its zoom is where it was, and it booted nothing again
    expect(await app(page, 'star-map').locator('#zoom-label').textContent()).toBe('Zoom 2×');
    expect(await stillMarked()).toBe(true);
    // the drag let go over another tile, so its click (if any) was not the grip's: the next one is
    await app(page, 'star-map').locator('.braid-tile-grip').press('Enter');
    expect(await app(page, 'star-map').locator('.braid-tile-grip').getAttribute('aria-expanded')).toBe('true');
    await page.keyboard.press('Escape');
    expect(await app(page, 'star-map').locator('.braid-tile-grip').getAttribute('aria-expanded')).toBe('false');

    // A touch drag arrives as the same pointer events, which is what this sends: it checks the
    // handlers with pointerType touch, not a finger on a screen. The grip opts out of scrolling.
    expect(await app(page, 'cargo').locator('.braid-tile-grip').evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
    const cargoGrip = await app(page, 'cargo').locator('.braid-tile-grip').boundingBox();
    const target = await app(page, 'star-map').boundingBox();
    await app(page, 'cargo').locator('.braid-tile-grip').dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 7, button: 0, buttons: 1, clientX: cargoGrip!.x + 5, clientY: cargoGrip!.y + 5, bubbles: true });
    await page.evaluate(([x, y]) => {
      dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', pointerId: 7, buttons: 1, clientX: x, clientY: y, bubbles: true }));
      dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 7, clientX: x, clientY: y, bubbles: true }));
    }, [target!.x + 80, target!.y + 160]);
    expect(await open(page)).toEqual(['cargo', 'star-map', 'flights']);

    // from the keyboard: Alt and an arrow on the grip, and a screen reader hears where it went
    await app(page, 'flights').locator('.braid-tile-grip').focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await page.keyboard.press('Alt+ArrowLeft');
    expect(await open(page)).toEqual(['flights', 'cargo', 'star-map']);
    expect(await page.locator('#braid-tiles-announcer').textContent()).toBe('Flights moved to position 1 of 3');
    expect(await page.evaluate(() => document.activeElement?.closest('fragment-slot')?.getAttribute('name'))).toBe('flights');

    // with one pointer and no drag: a click on the grip offers the same moves as buttons
    await app(page, 'flights').locator('.braid-tile-grip').click();
    expect(await app(page, 'flights').locator('.braid-tile-grip').getAttribute('aria-expanded')).toBe('true');
    await app(page, 'flights').locator('.braid-tile-menu button[data-step="1"]').click();
    expect(await open(page)).toEqual(['cargo', 'flights', 'star-map']);
    expect(await app(page, 'flights').locator('.braid-tile-menu').isVisible()).toBe(false);

    // a button let go where the page did not hear it ends the drag: moving on moves nothing
    const loose = await app(page, 'star-map').locator('.braid-tile-grip').boundingBox();
    await app(page, 'star-map').locator('.braid-tile-grip').dispatchEvent('pointerdown', { pointerId: 9, button: 0, buttons: 1, clientX: loose!.x + 5, clientY: loose!.y + 5, bubbles: true });
    const cargoBox = await app(page, 'cargo').boundingBox();
    await page.evaluate(([x, y]) => dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, buttons: 0, clientX: x, clientY: y, bubbles: true })), [cargoBox!.x + 60, cargoBox!.y + 120]);
    expect(await open(page)).toEqual(['cargo', 'flights', 'star-map']);
    expect(await page.evaluate(() => document.body.classList.contains('braid-tiles-moving'))).toBe(false);
    await page.context().close();
  });

  it('resizes a tile across columns and rows, by its buttons or its corner, and every tile is one column on a phone', async () => {
    const page = await desk();
    const map = app(page, 'star-map');
    const width = async () => (await map.boundingBox())!.width;
    const one = await width();

    await map.locator('.braid-tile-wider').click();
    expect(await map.getAttribute('data-braid-columns')).toBe('2');
    expect(await width()).toBeGreaterThan(one * 1.9);
    await map.locator('.braid-tile-wider').click();
    expect(await map.getAttribute('data-braid-columns')).toBe('3');
    await map.locator('.braid-tile-wider').click();
    // back to one column, which is no span at all
    expect(await map.getAttribute('data-braid-columns')).toBeNull();
    expect(Math.abs((await width()) - one)).toBeLessThan(12);
    expect(await map.locator('.braid-tile-wider').getAttribute('aria-label')).toBe('Star Map is 1 column wide. Change width');

    const tall = (await map.boundingBox())!.height;
    await map.locator('.braid-tile-taller').click();
    expect(await map.getAttribute('data-braid-rows')).toBe('3');
    expect((await map.boundingBox())!.height).toBeGreaterThan(tall * 1.4);

    // the corner snaps to whole columns and rows
    await map.locator('.braid-tile-taller').click(); // 3 → 1
    const corner = await map.locator('.braid-tile-edge[data-edge="corner"]').boundingBox();
    const box = await map.boundingBox();
    await page.mouse.move(corner!.x + 9, corner!.y + 9);
    await page.mouse.down();
    await page.mouse.move(corner!.x + 9 + box!.width + 20, corner!.y + 9 + box!.height + 40, { steps: 6 });
    await page.mouse.up();
    expect(await map.evaluate((slot) => [slot.getAttribute('data-braid-columns'), slot.getAttribute('data-braid-rows')])).toEqual(['2', null]);

    // at tablet width the grid is two columns: a three-column span fills the row, and is no wider
    await map.locator('.braid-tile-wider').click(); // 2 → 3
    expect(await map.getAttribute('data-braid-columns')).toBe('3');
    await page.setViewportSize({ width: 1000, height: 900 });
    const row = await page.locator('main').evaluate((desk) => {
      const style = getComputedStyle(desk);
      return desk.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    });
    expect(Math.abs((await width()) - row)).toBeLessThan(2);
    // and its width button goes no further than the grid does: from two columns, to one
    await map.locator('.braid-tile-wider').click();
    expect(await map.getAttribute('data-braid-columns')).toBeNull();

    // on a phone the grid is one column: every tile is as wide as that column, whatever its span
    await map.locator('.braid-tile-wider').click();
    await page.setViewportSize({ width: 390, height: 800 });
    const column = await page.locator('main').evaluate((desk) => {
      const style = getComputedStyle(desk);
      return desk.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    });
    const widths = await page.locator('main > fragment-slot').evaluateAll((slots) => slots.map((slot) => slot.getBoundingClientRect().width));
    for (const tile of widths) expect(Math.abs(tile - column)).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.context().close();
  });

  it('resizes a tile by dragging its right edge, its bottom edge or its corner, snapped, with an outline; Escape cancels; Shift+Alt+arrows from the keyboard', async () => {
    const page = await desk();
    const map = app(page, 'star-map');
    const span = () => map.evaluate((slot) => [slot.getAttribute('data-braid-columns'), slot.getAttribute('data-braid-rows')]);
    const outline = () =>
      page.evaluate(() => {
        const shown = document.querySelector<HTMLElement>('.braid-tile-outline');
        return shown ? { columns: shown.dataset.columns, rows: shown.dataset.rows, text: shown.textContent, width: shown.getBoundingClientRect().width } : null;
      });
    const gap = 20;
    /** Drags from the middle of `edge` by (dx, dy), and says what the outline showed before letting go. */
    async function drag(edge: string, dx: number, dy: number, { cancel = false } = {}) {
      // a tile three rows tall runs past the bottom of the window: its corner is scrolled to first
      await map.locator(`.braid-tile-edge[data-edge="${edge}"]`).scrollIntoViewIfNeeded();
      const handle = await map.locator(`.braid-tile-edge[data-edge="${edge}"]`).boundingBox();
      const x = handle!.x + handle!.width / 2;
      const y = handle!.y + handle!.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 6 });
      const shown = await outline();
      // nothing moves under the pointer: the tile takes its size only when it is let go
      const during = await span();
      if (cancel) await page.keyboard.press('Escape');
      await page.mouse.up();
      return { shown, during };
    }
    const one = (await map.boundingBox())!;

    // the right edge: columns only, snapped to whole columns
    // far down as well: a right edge that took rows too would make it three
    const right = await drag('right', one.width + gap + 30, 220);
    expect(right.during).toEqual([null, null]);
    expect(right.shown).toMatchObject({ columns: '2', rows: '2', text: '2 × 2' });
    expect(Math.abs(right.shown!.width - (one.width * 2 + gap))).toBeLessThan(3);
    expect(await span()).toEqual(['2', null]);
    expect(await outline()).toBeNull();

    // the bottom edge: rows only
    const row = (one.height - gap) / 2;
    // far left as well: a bottom edge that took columns too would make it one
    const bottom = await drag('bottom', -320, row + gap - 30);
    expect(bottom.shown).toMatchObject({ columns: '2', rows: '3' });
    expect(await span()).toEqual(['2', '3']);

    // the corner: both, back to one column and the default two rows, which is no span at all
    await map.locator('.braid-tile-edge[data-edge="corner"]').scrollIntoViewIfNeeded();
    const now = (await map.boundingBox())!;
    await drag('corner', -(now.width - one.width) + 15, -(now.height - one.height) - 20);
    expect(await span()).toEqual([null, null]);

    // Escape leaves it as it was
    const cancelled = await drag('right', one.width + gap, 0, { cancel: true });
    expect(cancelled.shown).toMatchObject({ columns: '2' });
    expect(await span()).toEqual([null, null]);
    expect(await outline()).toBeNull();

    // the keyboard: Shift, Alt and an arrow on the grip, and a screen reader hears the size
    await map.locator('.braid-tile-grip').focus();
    await page.keyboard.press('Shift+Alt+ArrowRight');
    await page.keyboard.press('Shift+Alt+ArrowDown');
    expect(await span()).toEqual(['2', '3']);
    expect(await page.locator('#braid-tiles-announcer').textContent()).toBe('Star Map is 2 columns wide and 3 rows tall');
    expect(await open(page)).toEqual(['flights', 'star-map', 'cargo']);
    await page.context().close();
  });

  it('saves order and spans in a layout, and restores both, after a reload too', async () => {
    const page = await desk();
    await app(page, 'cargo').locator('.braid-tile-grip').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await page.keyboard.press('Alt+ArrowUp');
    await app(page, 'flights').locator('.braid-tile-wider').click();
    await app(page, 'star-map').locator('.braid-tile-taller').click();
    const arranged = async () =>
      page.locator('main > fragment-slot').evaluateAll((slots) =>
        slots.map((slot) => [slot.getAttribute('name'), slot.getAttribute('data-braid-columns'), slot.getAttribute('data-braid-rows')]),
      );
    const wanted = [
      ['cargo', null, null],
      ['flights', '2', null],
      ['star-map', null, '3'],
    ];
    expect(await arranged()).toEqual(wanted);
    await page.locator('#layout-name').fill('ops');
    await page.locator('#save-layout button').click();
    await page.locator('#layouts button[data-restore="ops"]').waitFor();

    await page.reload();
    await ready(page);
    expect(await arranged()).toEqual([
      ['flights', null, null],
      ['star-map', null, null],
      ['cargo', null, null],
    ]);
    await page.locator('#layouts button[data-restore="ops"]').click();
    await expect.poll(arranged).toEqual(wanted);
    // a restored tile has its header like any other
    expect(await page.locator('main > fragment-slot > .braid-tile-head').count()).toBe(3);
    await page.context().close();
  });

  it('pops an app out into a window with its state, follows the desk from there, and brings it back when it closes', async () => {
    const page = await desk();
    await pick(page, 'NX-204');
    await app(page, 'star-map').locator('#in').click();
    await app(page, 'star-map').locator('#in').click();

    const [popup] = await Promise.all([page.context().waitForEvent('page'), app(page, 'star-map').locator('.braid-tile-pop').click()]);
    await popup.waitForLoadState();
    const inWindow = popup.locator('main fragment-slot[name="star-map"]');
    // its state went with it
    await expect.poll(() => inWindow.locator('#zoom-label').textContent(), { timeout: 15_000 }).toBe('Zoom 3×');
    expect(new URL(popup.url()).searchParams.get('app')).toBe('star-map');
    await expect.poll(() => open(page)).toEqual(['flights', 'cargo']);

    // a ship picked on the desk reaches the app in its window, another page with its own agent
    await expect.poll(() => inWindow.locator('#status').textContent()).toBe('Marigold is between Ceres and Europa.');
    await pick(page, 'KT-077');
    await expect.poll(() => inWindow.locator('#status').textContent()).toBe('Slow Comet is between Titan and Mars.');

    // zoomed out in its window, then the window is closed: it is back on the desk, as it was left
    await inWindow.locator('#out').click();
    // the window has its app's state from a moment after each change
    await popup.waitForTimeout(300);
    await popup.close({ runBeforeUnload: true });
    // back in the place it left, at the zoom it was left at, once the desk has given the window
    // its moment to take the app again (as a reloading window would)
    await expect.poll(() => open(page), { timeout: 5000 }).toEqual(['flights', 'star-map', 'cargo']);
    await expect.poll(() => app(page, 'star-map').locator('#zoom-label').textContent()).toBe('Zoom 2×');
    await page.context().close();
  });

  it('takes back an app popped out before the desk reloaded', async () => {
    const page = await desk();
    const [popup] = await Promise.all([page.context().waitForEvent('page'), app(page, 'cargo').locator('.braid-tile-pop').click()]);
    await popup.locator('main fragment-slot[name="cargo"] #manifest[data-loaded]').waitFor({ timeout: 15_000 });
    await expect.poll(() => open(page)).toEqual(['flights', 'star-map']);

    // the desk reloads (its starting apps come back), and only then is the window closed
    await page.reload();
    await ready(page);
    await popup.close({ runBeforeUnload: true });
    await expect.poll(() => open(page), { timeout: 5000 }).toEqual(['flights', 'star-map', 'cargo', 'cargo']);
    await page.context().close();
  });

  it('opens a copy in a tab for a modified click, and leaves the desk as it was', async () => {
    const page = await desk();
    const [tab] = await Promise.all([page.context().waitForEvent('page'), app(page, 'cargo').locator('.braid-tile-pop').click({ modifiers: ['ControlOrMeta'] })]);
    await tab.waitForLoadState();
    await tab.locator('main fragment-slot[name="cargo"] #manifest[data-loaded]').waitFor({ timeout: 15_000 });
    expect(await tab.locator('#back').isVisible()).toBe(false);
    expect(await open(page)).toEqual(['flights', 'star-map', 'cargo']);
    await page.context().close();
  });

  it('takes back only what it popped out: a forged return is ignored, and an app whose window never takes it comes back', async () => {
    const page = await desk();
    // a window that opens and never runs the desk: as if the user closed it at once
    await page.evaluate(() => {
      window.open = () => ({ closed: false }) as unknown as Window;
    });
    await app(page, 'cargo').locator('.braid-tile-pop').click();
    await expect.poll(() => open(page)).toEqual(['flights', 'star-map']);

    // another page of this origin posts a return for an app this desk did not pop out, and one
    // for Cargo under a handoff it made up
    await page.evaluate((base) => {
      const dock = new BroadcastChannel(`starport${base}dock`);
      dock.postMessage({ handoff: 'made-up', appId: 'radar', snapshot: {} });
      dock.postMessage({ handoff: 'made-up', appId: 'cargo', snapshot: { state: 'forged' } });
      dock.close();
    }, new URL(server.url).pathname);
    await page.waitForTimeout(300);
    expect(await open(page)).toEqual(['flights', 'star-map']);

    // ten seconds on, the desk takes Cargo back itself, and clears what it left in storage
    await expect.poll(() => open(page), { timeout: 15_000 }).toEqual(['flights', 'star-map', 'cargo']);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('handoff/')))).toEqual([]);
    await page.context().close();
  }, 30_000);

  it('restores a layout saved before tiles had spans', async () => {
    const page = await desk();
    // as the 0.8.1 desk wrote it: no placement on any slot
    await page.evaluate((key) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          savedAt: '2026-11-10T22:00:00.000Z',
          slots: [
            { appId: 'star-map', channel: 'fdc3.channel.1', state: { zoom: 3 } },
            { appId: 'cargo', channel: 'fdc3.channel.1' },
            { appId: 'radar', channel: 'fdc3.channel.1' },
          ],
        }),
      );
    }, `braid.workspace${new URL(server.url).pathname}layouts/before`);
    await page.reload();
    await ready(page);
    await page.locator('#layouts button[data-restore="before"]').click();
    await expect.poll(() => open(page)).toEqual(['star-map', 'cargo', 'radar']);
    await expect.poll(() => app(page, 'star-map').locator('#zoom-label').textContent()).toBe('Zoom 3×');
    expect(await page.locator('main > fragment-slot').evaluateAll((slots) => slots.map((slot) => slot.getAttribute('data-braid-columns') ?? slot.getAttribute('data-braid-rows')))).toEqual([null, null, null]);
    expect(await page.locator('main > fragment-slot > .braid-tile-head').count()).toBe(3);
    await page.context().close();
  });

  it('keeps a popped-out app in its window when the window reloads', async () => {
    const page = await desk();
    await app(page, 'star-map').locator('#in').click();
    const [popup] = await Promise.all([page.context().waitForEvent('page'), app(page, 'star-map').locator('.braid-tile-pop').click()]);
    const inWindow = popup.locator('main fragment-slot[name="star-map"]');
    await expect.poll(() => inWindow.locator('#zoom-label').textContent(), { timeout: 15_000 }).toBe('Zoom 2×');
    await inWindow.locator('#in').click();
    await popup.waitForTimeout(300);

    await popup.reload();
    await expect.poll(() => inWindow.locator('#zoom-label').textContent(), { timeout: 15_000 }).toBe('Zoom 3×');
    expect(await popup.locator('#back').isVisible()).toBe(true);
    // the desk left it there: give it time to have taken it back, if it were going to
    await page.waitForTimeout(2500);
    expect(await open(page)).toEqual(['flights', 'cargo']);

    // and it still comes back when the window really closes
    await popup.close({ runBeforeUnload: true });
    await expect.poll(() => open(page), { timeout: 5000 }).toEqual(['flights', 'star-map', 'cargo']);
    await expect.poll(() => app(page, 'star-map').locator('#zoom-label').textContent()).toBe('Zoom 3×');
    await page.context().close();
  });
  it('sends departures to apps popped out into windows, and back, and logs every crossing in the Traffic panel', async () => {
    const page = await desk();
    await page.locator('#traffic-toggle').click();
    expect(await page.locator('#traffic').isVisible()).toBe(true);
    expect(await page.locator('#traffic-empty').isVisible()).toBe(true);
    const lines = page.locator('#traffic-lines li');
    // a line matched on all of it: write or read, who and where, which channel, and what crossed
    const line = (kind: string, who: string, channel: string, what: string) => ({
      count: () =>
        lines.evaluateAll(
          (items, [k, w, c, t]) =>
            items.filter((item) => {
              const text = (selector: string) => item.querySelector(selector)?.textContent;
              return (item as HTMLElement).dataset.kind === k && text('.who') === w && text('.channel') === c && text('.what') === t;
            }).length,
          [kind, who, channel, what],
        ),
    });

    // Comms, out in a window of its own
    await page.locator('#dock [data-app="comms"] .launch').click();
    await app(page, 'comms').locator('#send').waitFor();
    const [commsWindow] = await Promise.all([page.context().waitForEvent('page'), app(page, 'comms').locator('.braid-tile-pop').click()]);
    const comms = commsWindow.locator('main fragment-slot[name="comms"]');
    await comms.locator('#send').waitFor({ timeout: 15_000 });

    // a departure marked on the desk reaches it there
    await pick(page, 'NX-204');
    await app(page, 'flights').locator('#depart').click();
    await expect.poll(() => comms.locator('#log').textContent(), { timeout: 5000 }).toContain('Tower: Marigold departed for Europa.');
    await expect.poll(() => comms.locator('#tower').textContent()).toBe('1 departure today');

    // and the desk's log shows it: who wrote it on the desk, and who read it, in which window
    await expect.poll(() => line('write', 'flights · desk', 'tower', 'event: ship.departed (Marigold)').count()).toBe(1);
    await expect.poll(() => line('write', 'flights · desk', 'tower', 'state: 1 departed (NX-204)').count()).toBe(1);
    await expect.poll(() => line('read', 'comms · comms window', 'tower', 'event: ship.departed (Marigold, from flights)').count()).toBe(1);
    await expect.poll(() => line('read', 'comms · comms window', 'tower', 'state: 1 departed (NX-204)').count()).toBe(1);
    await expect.poll(() => line('read', 'desk · desk', 'tower', 'event: ship.departed (Marigold, from flights)').count()).toBe(1);
    expect(await page.locator('#traffic-empty').isVisible()).toBe(false);
    // newest first, by when each was sent: the desk's read of the event sits above the write it followed
    const order = await lines.evaluateAll((items) => items.map((item) => `${item.dataset.kind} ${item.dataset.where} ${item.querySelector('.what')?.textContent}`));
    const wroteAt = order.indexOf('write desk event: ship.departed (Marigold)');
    const readAt = order.indexOf('read desk event: ship.departed (Marigold, from flights)');
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(wroteAt).toBeGreaterThan(readAt);
    // Flights does not log its own write as a read
    expect(await lines.filter({ hasText: 'flights · desk' }).and(page.locator('[data-kind="read"]')).count()).toBe(0);
    // the ship picked on the desk crossed to the window's own agent through the relay
    await expect.poll(() => line('write', 'relay · desk', 'starport.ship', 'ship: Marigold').count()).toBe(1);
    await expect.poll(() => line('read', 'relay · comms window', 'starport.ship', 'ship: Marigold').count()).toBe(1);

    // Flights, out in a window too: a departure marked there reaches the desk, and Comms in its window
    const [flightsWindow] = await Promise.all([page.context().waitForEvent('page'), app(page, 'flights').locator('.braid-tile-pop').click()]);
    const flights = flightsWindow.locator('main fragment-slot[name="flights"]');
    await flights.locator('tr[data-ship="KT-077"]').waitFor({ timeout: 15_000 });
    // the board it took with it: Marigold has left
    await expect.poll(() => flights.locator('tr[data-ship="NX-204"] .pill').textContent()).toBe('Departed');
    await flights.locator('tr[data-ship="KT-077"]').click();
    await flights.locator('#depart').click();
    await expect.poll(() => page.locator('#ticker-event').textContent()).toBe('Slow Comet departed for Mars');
    await expect.poll(() => page.locator('#ticker-count').textContent()).toBe('2 departures today');
    await expect.poll(() => comms.locator('#log').textContent()).toContain('Tower: Slow Comet departed for Mars.');
    await expect.poll(() => line('write', 'flights · flights window', 'tower', 'event: ship.departed (Slow Comet)').count()).toBe(1);
    await expect.poll(() => line('write', 'flights · flights window', 'tower', 'state: 2 departed (NX-204, KT-077)').count()).toBe(1);
    await expect.poll(() => line('write', 'relay · flights window', 'starport.ship', 'ship: Slow Comet').count()).toBe(1);
    await expect.poll(() => line('read', 'desk · desk', 'tower', 'event: ship.departed (Slow Comet, from flights)').count()).toBe(1);
    await expect.poll(() => line('read', 'comms · comms window', 'tower', 'event: ship.departed (Slow Comet, from flights)').count()).toBe(1);

    // Clear empties it, once the last of what was in flight has landed
    await expect.poll(() => line('read', 'relay · comms window', 'starport.ship', 'ship: Slow Comet').count()).toBe(1);
    await expect.poll(() => line('read', 'relay · desk', 'starport.ship', 'ship: Slow Comet').count()).toBe(1);
    await page.locator('#traffic-clear').click();
    await expect.poll(() => lines.count()).toBe(0);
    expect(await page.locator('#traffic-empty').isVisible()).toBe(true);
    await page.locator('#traffic-toggle').click();
    expect(await page.locator('#traffic').isVisible()).toBe(false);
    expect(await page.locator('#traffic-toggle').getAttribute('aria-expanded')).toBe('false');
    // a popped-out window has no Traffic panel of its own: the desk shows the log
    expect(await commsWindow.locator('#traffic-toggle').isVisible()).toBe(false);
    await page.context().close();
  });

  it('logs a state read and no event for an app that comes after a departure', async () => {
    const page = await desk();
    await page.locator('#traffic-toggle').click();
    await pick(page, 'NX-204');
    await app(page, 'flights').locator('#depart').click();
    await expect.poll(() => page.locator('#ticker-count').textContent()).toBe('1 departure today');
    await page.locator('#traffic-clear').click();

    await page.locator('#dock [data-app="comms"] .launch').click();
    await expect.poll(() => app(page, 'comms').locator('#tower').textContent()).toBe('1 departure today');
    const comms = page.locator('#traffic-lines li[data-kind="read"][data-where="desk"]').filter({ hasText: 'comms' });
    await expect.poll(() => comms.filter({ hasText: 'state: 1 departed' }).count()).toBe(1);
    // give a replayed event every chance to show up: none does
    await page.waitForTimeout(500);
    expect(await comms.filter({ hasText: 'event:' }).count()).toBe(0);
    expect(await app(page, 'comms').locator('#log').textContent()).not.toContain('Marigold');
    await page.context().close();
  });
  it('gives a shared link a title, a description and a preview image', async () => {
    const page = await desk();
    const meta = (selector: string) => page.locator(selector).getAttribute('content');
    expect(await meta('meta[name="description"]')).toContain('Braid');
    expect(await meta('meta[property="og:title"]')).toBe('Starport — a Braid workspace demo');
    expect(await meta('meta[name="twitter:card"]')).toBe('summary_large_image');
    expect(await meta('meta[name="twitter:title"]')).toBe('Starport — a Braid workspace demo');
    const image = await meta('meta[property="og:image"]');
    expect(image).toBe('https://braidjs.github.io/braid/starport/og.png');
    expect(await meta('meta[name="twitter:image"]')).toBe(image);
    expect(await meta('meta[property="og:image:width"]')).toBe('1200');
    expect(await meta('meta[property="og:image:height"]')).toBe('630');
    // the image is in the build, where that URL points once deployed
    const served = await fetch(new URL('og.png', server.url));
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('image/png');
    // and is the size the tags say: a PNG's width and height are bytes 16-23 of its IHDR
    const png = new DataView(await served.arrayBuffer());
    expect([png.getUint32(16), png.getUint32(20)]).toEqual([1200, 630]);
    await page.context().close();
  });
});

