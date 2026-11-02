import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { endpoint, html, launch, readySlots, startHost, type Host } from './harness.js';

/**
 * Angular's critical-CSS output loads the global stylesheet as `media="print"` with an `onload`
 * that switches it to `all`. The gateway strips the handler; the sheet must still apply.
 */

let browser: Browser;
// one host per case: on a shared page, one slot's outcome must not stand in for the other's
const hosts: Record<string, Host> = {};

const app = endpoint((path) =>
  path.endsWith('/styles.css')
    ? new Response('h1 { color: rgb(1, 2, 3); }', { headers: { 'content-type': 'text/css' } })
    : html(
        `<!doctype html><html><head><base href="/">` +
          `<link rel="stylesheet" href="styles.css" media="print" onload="this.media='all'">` +
          // Angular also emits a <noscript> copy of the link. Left out: on the composed path the
          // client parses with DOMParser, where scripting is off, so that copy would apply and hide
          // whether the deferred link itself works. On a pierced page it is inert text.

          `</head><body><h1 id="title">styled</h1></body></html>`,
      ),
);

beforeAll(async () => {
  browser = await launch();
  hosts.composed = await startHost({
    gateway: { registry: [{ id: 'composed', endpoint: app }] },
    body: '<fragment-slot name="composed"></fragment-slot>',
  });
  hosts.pierced = await startHost({
    gateway: { registry: [{ id: 'pierced', pierce: ['/'], endpoint: app }] },
    body: '<fragment-slot name="pierced"></fragment-slot>',
  });
});

afterAll(async () => {
  await browser?.close();
  await Promise.all(Object.values(hosts).map((host) => host.close()));
});

describe('a deferred stylesheet', () => {
  it.each(['composed', 'pierced'])('applies in a %s fragment', async (name) => {
    const page = await browser.newPage();
    await page.goto(hosts[name].url);
    await readySlots(page, name);
    const color = await page.waitForFunction(
      (slotName) => {
        const title = document.querySelector(`fragment-slot[name="${slotName}"]`)?.shadowRoot?.querySelector('#title');
        const value = title && getComputedStyle(title).color;
        return value === 'rgb(1, 2, 3)' ? value : null;
      },
      name,
      { timeout: 10_000 },
    );
    expect(await color.jsonValue()).toBe('rgb(1, 2, 3)');
    await page.close();
  });
});
