import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { bundleCore, launch, readySlots, startHost, type Host } from './harness.js';

/**
 * An untrusted fragment's frame lives inside its slot, so a move that disconnects the slot reloads
 * the frame — and a reloaded frame has nobody to connect to. The slot reboots instead, and the
 * vendor's new document connects. `moveBefore` reloads nothing, so it keeps the connection it had.
 */

let browser: Browser;
let host: Host;
let vendor: Server;
let vendorUrl: string;
let hostOrigin = '';
let vendorLoads = 0;

beforeAll(async () => {
  browser = await launch();
  const core = await bundleCore();

  vendor = createServer((req, res) => {
    if (req.url === '/core.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }).end(core);
      return;
    }
    vendorLoads++;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><body>
<script type="module">
  import { connectToBraidHost } from '/core.js';
  await connectToBraidHost({ hostOrigin: ${JSON.stringify(hostOrigin)} });
  document.body.dataset.connected = 'yes';
</script></body></html>`);
  });
  await new Promise<void>((resolve) => vendor.listen(0, 'localhost', resolve));
  vendorUrl = `http://localhost:${(vendor.address() as AddressInfo).port}/widget`;

  host = await startHost({
    gateway: { registry: [] },
    body:
      `<div id="a"><fragment-slot name="vendor" trust="untrusted" src="${vendorUrl}"></fragment-slot></div><div id="b"></div>` +
      `<script>
        window.states = [];
        document.querySelector('fragment-slot').addEventListener('braid:state', (event) => window.states.push(event.detail.state));
      </script>`,
  });
  hostOrigin = new URL(host.url).origin;
});

afterAll(async () => {
  await browser?.close();
  await host?.close();
  await new Promise((resolve) => vendor?.close(resolve));
});

/** Whether the vendor frame now in the slot has connected. */
async function connected(page: Page): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    for (const frame of page.frames().filter((candidate) => candidate.url().startsWith(vendorUrl))) {
      if (await frame.evaluate(() => document.body.dataset.connected === 'yes').catch(() => false)) return true;
    }
    await page.waitForTimeout(100);
  }
  return false;
}

it('reboots an untrusted fragment moved by append, and its new frame connects', async () => {
  const page = await browser.newPage();
  await page.goto(host.url);
  await readySlots(page, 'vendor');
  expect(await connected(page)).toBe(true);
  const loadsBefore = vendorLoads;

  await page.evaluate(() => document.getElementById('b')!.append(document.querySelector('fragment-slot[name="vendor"]')!));
  await page.waitForFunction(() => (window as unknown as { states: string[] }).states.includes('closing'), undefined, { timeout: 5_000 });
  await readySlots(page, 'vendor');

  expect(await connected(page)).toBe(true);
  expect(vendorLoads).toBeGreaterThan(loadsBefore);
  await page.close();
});

it('keeps an untrusted fragment connected through moveBefore', async () => {
  const page = await browser.newPage();
  await page.goto(host.url);
  await readySlots(page, 'vendor');
  expect(await connected(page)).toBe(true);
  const loadsBefore = vendorLoads;

  await page.evaluate(() => {
    const target = document.getElementById('b')! as Element & { moveBefore(node: Node, child: Node | null): void };
    target.moveBefore(document.querySelector('fragment-slot[name="vendor"]')!, null);
  });
  await page.waitForTimeout(500);

  expect(vendorLoads).toBe(loadsBefore);
  expect(await page.evaluate(() => (window as unknown as { states: string[] }).states)).not.toContain('closing');
  expect(await connected(page)).toBe(true);
  await page.close();
});
