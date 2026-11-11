import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext } from 'playwright';
import { launch } from './harness.js';
// the example itself, not a copy of it: what it documents is what this runs
import { bundle, start } from '../examples/sw-gateway/server.mjs';

/**
 * The gateway in a service worker (`@braidlabs/sw/gateway`), in front of a static server that has
 * never heard of Braid. Composition, realm boot, and piercing all have to come from the worker.
 */

const root = new URL('../', import.meta.url).pathname;

let browser: Browser;
let server: { url: string; close(): Promise<void> };
const requested: string[] = [];

beforeAll(async () => {
  browser = await launch();
  server = await start({
    bundles: await bundle({ tsconfig: `${root}tsconfig.base.json` }),
    onRequest: (path: string) => requested.push(path),
    // as a CDN would: the browser asks for zstd itself, which the gateway in the worker cannot pin
    compress: 'zstd',
  });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** A fresh profile: no worker installed yet, as on a first visit. */
async function firstVisit(): Promise<BrowserContext> {
  return browser.newContext();
}

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

describe('the gateway in a service worker', () => {
  it('composes and boots a fragment once the worker controls the page', async () => {
    const context = await firstVisit();
    const page = await context.newPage();
    await page.goto(server.url);

    const status = await page.waitForFunction(
      () =>
        document
          .querySelector('fragment-slot[name="billing"]')
          ?.shadowRoot?.querySelector('#status')?.textContent ===
        'booted in its realm',
      undefined,
      { timeout: 15_000 },
    );
    expect(await status.jsonValue()).toBe(true);
    expect(
      await page.evaluate(() => navigator.serviceWorker.controller !== null),
    ).toBe(true);
    await context.close();
  });

  it('pierces a navigation in the worker, from a shell the server serves unpierced', async () => {
    const context = await firstVisit();
    const page = await context.newPage();
    await page.goto(server.url);
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
      undefined,
      { timeout: 15_000 },
    );

    const response = await page.goto(`${server.url}billing`);
    expect(response?.fromServiceWorker()).toBe(true);
    // the fragment's markup is in the document the browser parsed, before any script ran
    const html = await response!.text();
    expect(html).toContain('<h1 id="title">Billing</h1>');
    expect(html).toMatch(
      /<fragment-slot name="billing"[^>]*>\s*<template shadowrootmode/,
    );
    await context.close();
  });

  it('boots again after a hard reload, which loads the page past the worker', async () => {
    const context = await firstVisit();
    const page = await context.newPage();
    await page.goto(server.url);
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
      undefined,
      { timeout: 15_000 },
    );

    // shift-reload: the page comes up uncontrolled, with the worker already active
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.reload', { ignoreCache: true });
    await page.waitForLoadState('load');
    const status = await page.waitForFunction(
      () =>
        document
          .querySelector('fragment-slot[name="billing"]')
          ?.shadowRoot?.querySelector('#status')?.textContent ===
        'booted in its realm',
      undefined,
      { timeout: 15_000 },
    );
    expect(await status.jsonValue()).toBe(true);
    await context.close();
  });

  it('starts the worker only for what it answers: everything else is routed to the network at install', async () => {
    const context = await firstVisit();
    const page = await context.newPage();
    await page.goto(server.url);
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
      undefined,
      { timeout: 15_000 },
    );

    // a page load under the worker: its navigation and the realm frame's are the worker's, the
    // shell's own script is not
    await page.reload();
    await page.waitForFunction(
      () =>
        document
          .querySelector('fragment-slot[name="billing"]')
          ?.shadowRoot?.querySelector('#status')?.textContent ===
        'booted in its realm',
      undefined,
      { timeout: 15_000 },
    );
    const sources = await page.evaluate(() =>
      [
        ...performance.getEntriesByType('navigation'),
        ...performance.getEntriesByType('resource'),
      ].map((entry) => {
        const timing = entry as PerformanceResourceTiming & {
          workerMatchedSourceType?: string;
        };
        return {
          path: new URL(timing.name).pathname,
          source: timing.workerMatchedSourceType,
        };
      }),
    );

    const sourceOf = (match: (path: string) => boolean) =>
      sources.find((entry) => match(entry.path))?.source;
    expect(sourceOf((path) => path === '/'), JSON.stringify(sources)).toBe(
      'fetch-event',
    );
    expect(
      sourceOf((path) => path.startsWith('/__braid/realm/billing')),
      JSON.stringify(sources),
    ).toBe('fetch-event');
    expect(
      sourceOf((path) => path.endsWith('.js') && !path.startsWith('/__braid/')),
      JSON.stringify(sources),
    ).toBe('network');
    await context.close();
  });

  it('never sends a /__braid/ request to the static server', () => {
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.filter((path) => path.startsWith('/__braid/'))).toEqual(
      [],
    );
    // while the billing app's own files were fetched — by the worker, on the page's behalf
    expect(requested).toContain('/billing-app/main.js');
  });

  it('answers a request-target that is not a URL with a 400, and keeps serving', async () => {
    // `//` throws from `new URL`; uncaught, that took the whole server down, and any page can
    // make a browser send it
    expect(await rawGet(server.url, '//')).toBe('HTTP/1.1 400 Bad Request');
    expect((await fetch(server.url)).status).toBe(200);
  });
});
