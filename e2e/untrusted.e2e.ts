import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser, Frame, Page } from 'playwright';
import { bundleCore, launch, readySlots, startHost, type Host } from './harness.js';

/**
 * The untrusted tier in a real browser, with the default sandbox tokens.
 *
 * The vendor is served from `localhost` and the host from `127.0.0.1`, two origins. Without
 * `allow-same-origin` the vendor's frame runs in an opaque origin, which the host cannot address by
 * name, so this is the case the handshake has to work for: the guest announces itself and the host
 * answers that window. What the vendor then reads is only what its grant names.
 */

let browser: Browser;
let host: Host;
let vendor: Server;
let vendorUrl: string;
let hostOrigin = '';

beforeAll(async () => {
  browser = await launch();
  const core = await bundleCore();

  vendor = createServer((req, res) => {
    if (req.url === '/core.js') {
      // A frame in an opaque origin fetches module scripts in CORS mode.
      res.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }).end(core);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><body>
<script type="module">
  import { connectToBraidHost } from '/core.js';
  const session = await connectToBraidHost({ hostOrigin: ${JSON.stringify(hostOrigin)} });
  document.body.dataset.user = JSON.stringify(session.context.get('user') ?? null);
  document.body.dataset.session = JSON.stringify(session.context.get('session') ?? null);
  document.body.dataset.origin = String(self.origin);
  document.body.dataset.connected = 'yes';
  session.settled();
</script></body></html>`);
  });
  await new Promise<void>((resolve) => vendor.listen(0, 'localhost', resolve));
  vendorUrl = `http://localhost:${(vendor.address() as AddressInfo).port}/widget`;

  host = await startHost({
    gateway: { registry: [] },
    head: `<script type="module">
      import { braidContext } from '/core.js';
      braidContext.set('user', { id: 'u1' });
      braidContext.set('session', { token: 'secret' });
    </script>`,
    braid: { capabilities: { vendor: { context: { read: ['user'] } } } },
    body: `<fragment-slot name="vendor" trust="untrusted" src="${vendorUrl}"></fragment-slot>`,
  });
  hostOrigin = new URL(host.url).origin;
});

afterAll(async () => {
  await browser?.close();
  await host?.close();
  await new Promise((resolve) => vendor?.close(resolve));
});

async function vendorFrame(page: Page): Promise<Frame> {
  for (let i = 0; i < 100; i++) {
    const frame = page.frames().find((candidate) => candidate.url().startsWith(vendorUrl));
    if (frame) return frame;
    await page.waitForTimeout(100);
  }
  throw new Error('the vendor frame never appeared');
}

it('connects an untrusted fragment from an opaque origin and gives it only what its grant names', async () => {
  const page = await browser.newPage();
  await page.goto(host.url);
  await readySlots(page, 'vendor');

  const frame = await vendorFrame(page);
  await frame.waitForSelector('body[data-connected="yes"]', { state: 'attached', timeout: 15_000 });
  const read = (key: string) => frame.evaluate((k) => JSON.parse(document.body.dataset[k] ?? 'undefined'), key);

  // Opaque: the frame never had the vendor's origin, let alone the host's.
  expect(await frame.evaluate(() => document.body.dataset.origin)).toBe('null');
  expect(await read('user')).toEqual({ id: 'u1' });
  expect(await read('session')).toBeNull();

  const sandbox = await page.evaluate(
    () => document.querySelector('fragment-slot[name="vendor"]')!.shadowRoot!.querySelector('iframe')!.getAttribute('sandbox'),
  );
  expect(sandbox).not.toContain('allow-same-origin');
  await page.close();
});
