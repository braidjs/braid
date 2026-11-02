import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { endpoint, html, launch, startHost, type Host } from './harness.js';

/**
 * `settled` in a real browser: a slot is `healthy` as soon as its realm beats, while the app inside
 * may still be loading. `settled` waits for the fragment to say so — or for the fallback.
 */

let browser: Browser;
let host: Host;

beforeAll(async () => {
  browser = await launch();
  host = await startHost({
    gateway: {
      registry: [
        // a compat app that finishes its own loading well after it mounts, and says so
        {
          id: 'reports',
          endpoint: endpoint(() =>
            html(`<h1>loading…</h1><script>setTimeout(function () { window[Symbol.for('braid.fragment')].settled(); }, 2000);</script>`),
          ),
        },
        // one that never says anything
        { id: 'silent', endpoint: endpoint(() => html('<h1>silent</h1>')) },
      ],
    },
    body:
      '<fragment-slot name="reports"></fragment-slot><fragment-slot name="silent" settle-timeout="1000"></fragment-slot>' +
      `<script>
        window.settledEvents = [];
        for (const slot of document.querySelectorAll('fragment-slot')) {
          slot.addEventListener('braid:settled', (event) => settledEvents.push({ ...event.detail, state: slot.state }));
        }
      </script>`,
  });
});

afterAll(async () => {
  await browser?.close();
  await host?.close();
});

describe('settled', () => {
  it('comes after healthy, when the fragment reports it', async () => {
    const page = await browser.newPage();
    await page.goto(host.url);
    await page.waitForSelector('fragment-slot[name="reports"][state="healthy"]', { state: 'attached', timeout: 15_000 });
    expect(await page.getAttribute('fragment-slot[name="reports"]', 'settled')).toBeNull();

    await page.waitForSelector('fragment-slot[name="reports"][settled]', { state: 'attached', timeout: 10_000 });
    const events = await page.evaluate(() => (window as unknown as { settledEvents: unknown[] }).settledEvents);
    expect(events).toContainEqual({ fragmentId: 'reports', timedOut: false, state: 'healthy' });
    await page.close();
  });

  it('falls back to settling on its own when the fragment never reports', async () => {
    const page = await browser.newPage();
    await page.goto(host.url);
    await page.waitForSelector('fragment-slot[name="silent"][settled]', { state: 'attached', timeout: 15_000 });
    const events = await page.evaluate(() => (window as unknown as { settledEvents: { fragmentId: string }[] }).settledEvents);
    expect(events.find((event) => event.fragmentId === 'silent')).toMatchObject({ timedOut: true });
    await page.close();
  });
});
