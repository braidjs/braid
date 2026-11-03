import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { endpoint, html, launch, readySlots, startHost, type Host } from './harness.js';

/**
 * A host page that enforces Trusted Types (`require-trusted-types-for 'script'`) and allows one
 * policy, Braid's. The runtime's own writes go through that policy, so every kind of fragment boots
 * with its scripts in its realm. A fragment's own raw HTML writes meet the host's enforcement, as
 * they should: that is what turning it on is for.
 */

let browser: Browser;
let host: Host;

/** A compat fragment whose script records that it ran, in its own markup. */
const ran = (id: string) =>
  html(`<p id="${id}">waiting</p><script>document.getElementById(${JSON.stringify(id)}).dataset.ran = 'yes';</script>`);

/** A compat fragment that writes raw markup, directly and through a setter it captured, and records what happened. */
const writes = (id: string) =>
  html(
    `<div id="${id}-direct"></div><div id="${id}-captured"></div><p id="${id}-done"></p>` +
      `<script>
        const outcome = (write) => { try { write(); return 'written'; } catch (error) { return error.name; } };
        const done = document.getElementById(${JSON.stringify(`${id}-done`)});
        done.dataset.direct = outcome(() => { document.getElementById(${JSON.stringify(`${id}-direct`)}).innerHTML = '<b id="${id}-b">bold</b><img src="x" onerror="window.parent.pwned = true">'; });
        const setter = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML').set;
        done.dataset.captured = outcome(() => { setter.call(document.getElementById(${JSON.stringify(`${id}-captured`)}), '<i>captured</i>'); });
      </script>`,
  );

beforeAll(async () => {
  browser = await launch();
  host = await startHost({
    pageHeaders: { 'content-security-policy': "require-trusted-types-for 'script'; trusted-types braid" },
    gateway: {
      registry: [
        { id: 'pierced', pierce: ['/'], bound: false, src: '/', endpoint: endpoint(() => ran('pierced-p')) },
        { id: 'fetched', endpoint: endpoint(() => ran('fetched-p')) },
        {
          id: 'contract',
          endpoint: endpoint(
            () =>
              new Response(
                `globalThis.__braidFragment = { mount(env) {
                  const p = env.root.ownerDocument.createElement('p');
                  p.id = 'contract-p';
                  p.textContent = 'mounted';
                  env.root.append(p);
                } };`,
                { headers: { 'content-type': 'text/javascript' } },
              ),
          ),
        },
        { id: 'writer', endpoint: endpoint(() => writes('writer')) },
        { id: 'sanitized', capabilities: { html: 'sanitize' }, endpoint: endpoint(() => writes('sanitized')) },
      ],
    },
    head: `<script>
      window.violations = [];
      document.addEventListener('securitypolicyviolation', (event) => window.violations.push({ directive: event.effectiveDirective, sample: event.sample, at: event.sourceFile + ':' + event.lineNumber + ':' + event.columnNumber }));
    </script>`,
    body:
      '<fragment-slot name="pierced"></fragment-slot>' +
      '<fragment-slot name="fetched"></fragment-slot>' +
      '<fragment-slot name="contract" adapter="contract" entry="/__braid/frag/contract/entry.js"></fragment-slot>' +
      '<fragment-slot name="writer"></fragment-slot>' +
      '<fragment-slot name="sanitized"></fragment-slot>',
  });
});

afterAll(async () => {
  await browser?.close();
  await host?.close();
});

const inSlot = (page: Page, slot: string, selector: string) =>
  page.waitForFunction(
    ([name, query]) => document.querySelector(`fragment-slot[name="${name}"]`)?.shadowRoot?.querySelector(query) ?? null,
    [slot, selector] as const,
    { timeout: 15_000 },
  );

describe('a host that enforces Trusted Types', () => {
  let page: Page;
  const realmErrors: string[] = [];

  beforeAll(async () => {
    page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') realmErrors.push(message.text());
    });
    await page.goto(host.url);
    await readySlots(page, 'pierced', 'fetched', 'contract', 'writer', 'sanitized');
  });

  afterAll(async () => {
    await page?.close();
  });

  it('boots pierced, fetched and contract fragments, their code running in their realms', async () => {
    await inSlot(page, 'pierced', '#pierced-p[data-ran="yes"]');
    await inSlot(page, 'fetched', '#fetched-p[data-ran="yes"]');
    await inSlot(page, 'contract', '#contract-p');
  });

  it('blocks a fragment’s raw HTML write, however it reaches the setter', async () => {
    const done = await inSlot(page, 'writer', '#writer-done[data-direct]');
    expect(await done.evaluate((element) => ({ ...(element as HTMLElement).dataset }))).toEqual({
      direct: 'TypeError',
      captured: 'TypeError',
    });
    expect(await page.evaluate(() => (window as unknown as { pwned?: boolean }).pwned)).toBeUndefined();
  });

  it('lets a fragment that opted into sanitizing write, cleaned', async () => {
    await inSlot(page, 'sanitized', '#sanitized-b');
    const done = await inSlot(page, 'sanitized', '#sanitized-done[data-direct]');
    expect(await done.evaluate((element) => (element as HTMLElement).dataset['direct'])).toBe('written');
    const img = await page.evaluate(
      () => document.querySelector('fragment-slot[name="sanitized"]')!.shadowRoot!.querySelector('#sanitized-direct img')?.getAttribute('onerror') ?? null,
    );
    expect(img).toBeNull();
  });

  it('reports no violation of its own: only the fragment’s blocked writes', async () => {
    const violations = await page.evaluate(() => (window as unknown as { violations: { sample: string }[] }).violations);
    const braidCaused = violations.filter((violation) => !/bold|captured/.test(violation.sample));
    expect(braidCaused, JSON.stringify(violations)).toEqual([]);
    // the realms report in the console: nothing of Braid's own (a script it wrote, or a boot error)
    expect(realmErrors.filter((text) => /TrustedScript|BraidError/.test(text)), realmErrors.join('\n')).toEqual([]);
  });
});
