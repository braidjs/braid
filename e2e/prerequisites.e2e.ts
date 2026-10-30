import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { endpoint, html, launch, startHost, type Host } from './harness.js';

/**
 * Mount prerequisites in a real browser: a fragment's code waits for the keys it requires, a user
 * without access gets the slot's fallback, and a key many slots need is resolved once.
 */

const fragment = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  ...extra,
  endpoint: endpoint(() => html(`<p id="${id}-content">${id}</p><script>top.__ran = (top.__ran || []).concat('${id}')</script>`)),
});

let browser: Browser;
let host: Host;

beforeAll(async () => {
  browser = await launch();
  host = await startHost({
    gateway: {
      registry: [fragment('kcd'), fragment('kcd-two'), fragment('payroll', { requires: ['group:hr'] })],
    },
    head: `<script>
      window.__calls = [];
      window.__gate = new Promise(function (release) { window.__release = release; });
    </script>`,
    braidSource: `{
      prerequisites: {
        'session:*': function (key) { window.__calls.push(key); return window.__gate.then(function () { return 'ready'; }); },
        'group:hr': function () { return 'not-entitled'; },
      },
    }`,
    body: `
      <fragment-slot name="kcd" requires="session:kcd"></fragment-slot>
      <fragment-slot name="kcd-two" requires="session:kcd"></fragment-slot>
      <fragment-slot name="payroll"><p slot="fallback" id="payroll-fallback">Payroll is not available to you.</p></fragment-slot>`,
  });
});

afterAll(async () => {
  await browser?.close();
  await host?.close();
});

const state = (page: Page, name: string) => page.evaluate((n) => document.querySelector(`fragment-slot[name="${n}"]`)!.getAttribute('state'), name);
const ran = (page: Page) => page.evaluate(() => (window as unknown as { __ran?: string[] }).__ran ?? []);

it("holds a fragment's code until its prerequisite is ready, resolving a shared key once", async () => {
  const page = await browser.newPage();
  await page.goto(host.url);
  // the document may paint, inert; the fragment's code must not run
  await page.waitForTimeout(800);
  expect(await state(page, 'kcd')).toBe('loading');
  expect(await ran(page)).not.toContain('kcd');

  await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await page.waitForSelector('fragment-slot[name="kcd"]:is([state="ready"], [state="healthy"])', { state: 'attached' });
  await page.waitForSelector('fragment-slot[name="kcd-two"]:is([state="ready"], [state="healthy"])', { state: 'attached' });
  expect(await ran(page)).toEqual(expect.arrayContaining(['kcd', 'kcd-two']));
  expect(await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls)).toEqual(['session:kcd']);
  await page.close();
});

it('shows the fallback, without logging a failure, to a user who is not entitled', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.goto(host.url);
  await page.waitForSelector('fragment-slot[name="payroll"][state="error"]', { state: 'attached' });

  expect(await page.isVisible('#payroll-fallback')).toBe(true);
  expect(await ran(page)).not.toContain('payroll');
  expect(errors).toEqual([]);
  await page.close();
});
