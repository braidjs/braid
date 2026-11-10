import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { bundleModule, endpoint, html, launch, readySlots, startHost, type Host } from './harness.js';

/**
 * How a compat fragment — an unmodified app, with no `env` — talks to the host that placed it.
 * The tutorial (docs/tutorial/04-props-and-events.md) teaches exactly this, so it is pinned here:
 * slot props and `braid:event` do not reach compat code; a composed DOM event and a page channel do.
 */

interface Heard {
  where: string;
  type: string;
  detail: unknown;
}

let browser: Browser;
let host: Host;

beforeAll(async () => {
  browser = await launch();
  const data = bundleModule('libs/data/src/index.ts');
  host = await startHost({
    modules: { '/data.js': data },
    gateway: {
      registry: [
        {
          id: 'billing',
          endpoint: endpoint(async (path) =>
            path.endsWith('/data.js')
              ? new Response(await data, { headers: { 'content-type': 'text/javascript' } })
              : html(
                  `<p id="account">none</p><button id="plain">plain</button><button id="composed">composed</button>
<script type="module">
  import { createEventBus } from './data.js';
  const detail = { invoiceId: 'INV-101' };
  document.querySelector('#plain').addEventListener('click', () =>
    window.dispatchEvent(new CustomEvent('invoice:paid', { detail, bubbles: true })));
  document.querySelector('#composed').addEventListener('click', () =>
    window.dispatchEvent(new CustomEvent('invoice-paid', { detail, bubbles: true, composed: true })));
  createEventBus({ consumer: 'billing' }).channel('account').subscribe((account) => {
    document.querySelector('#account').textContent = account.accountId;
  });
</script>`,
                ),
          ),
        },
      ],
    },
    body: `<main id="shell"><fragment-slot name="billing"></fragment-slot></main>
<script type="module">
  import { createEventBus } from '/data.js';
  const slot = document.querySelector('fragment-slot');
  slot.props = { accountId: 'ACC-PROPS' };
  window.__heard = [];
  const hear = (where) => (event) => window.__heard.push({ where, type: event.type, detail: event.detail });
  for (const type of ['braid:event', 'invoice:paid', 'invoice-paid']) slot.addEventListener(type, hear('slot'));
  document.querySelector('#shell').addEventListener('invoice-paid', hear('shell'));
  // published before the fragment exists: it is a late subscriber
  window.__account = createEventBus({ consumer: 'shell' }).channel('account');
  window.__account.broadcast({ accountId: 'ACC-99201' });
</script>`,
  });
});

afterAll(async () => {
  await browser?.close();
  await host?.close();
});

async function open(): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(host.url);
  await readySlots(page, 'billing');
  return page;
}

const heard = (page: Page) => page.evaluate(() => (window as unknown as { __heard: Heard[] }).__heard);

describe('a compat fragment and its host', () => {
  it('does not reach the host with a plain window.dispatchEvent: not as braid:event, not as itself', async () => {
    const page = await open();
    await page.click('#plain');
    await page.waitForTimeout(200);
    expect(await heard(page)).toEqual([]);
    await page.close();
  });

  it('reaches the slot, and its ancestors, with a composed event', async () => {
    const page = await open();
    await page.click('#composed');
    await page.waitForFunction(() => (window as unknown as { __heard: Heard[] }).__heard.length >= 2);
    expect(await heard(page)).toEqual([
      { where: 'slot', type: 'invoice-paid', detail: { invoiceId: 'INV-101' } },
      { where: 'shell', type: 'invoice-paid', detail: { invoiceId: 'INV-101' } },
    ]);
    await page.close();
  });

  it('hears the host on a page channel, however late it mounted, and then every change', async () => {
    const page = await open();
    await page.waitForFunction(() => document.querySelector('fragment-slot')?.shadowRoot?.querySelector('#account')?.textContent === 'ACC-99201');
    await page.evaluate(() => (window as unknown as { __account: { broadcast(v: unknown): void } }).__account.broadcast({ accountId: 'ACC-44012' }));
    await page.waitForFunction(() => document.querySelector('fragment-slot')?.shadowRoot?.querySelector('#account')?.textContent === 'ACC-44012');
    await page.close();
  });
});
