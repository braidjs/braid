import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { endpoint, html, launch, readySlots, startHost, type Host } from './harness.js';

let browser: Browser;
let host: Host;

beforeAll(async () => {
  browser = await launch();
  host = await startHost({
    gateway: {
      registry: [
        {
          id: 'hello',
          endpoint: endpoint(() =>
            html(`<h1 id="greeting">hello</h1><script>top.__seen = (top.__seen || []).concat(document.querySelector('#greeting').textContent)</script>`),
          ),
        },
      ],
    },
    body: '<fragment-slot name="hello"></fragment-slot>',
  });
});
afterAll(async () => {
  await browser?.close();
  await host?.close();
});

it('boots a compat fragment through the gateway in Chromium', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(host.url);
  await readySlots(page, 'hello');
  expect(await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)).toEqual(['hello']);
  expect(errors).toEqual([]);
});
