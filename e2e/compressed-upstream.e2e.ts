import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import type { Browser } from 'playwright';
import { launch, startHost, type Host } from './harness.js';

/**
 * A fragment served by a dev server that compresses, behind the Node gateway, loaded directly many
 * times over the same browser connection pool. `fetch` decodes the upstream body; if the gateway
 * forwarded the upstream's length and coding, the surplus bytes would corrupt the next response on
 * the keep-alive socket — a realm stub, often — and the slot would fail with `realm-boot`.
 */

const LOADS = 12;

let browser: Browser;
let host: Host;
let upstream: Server;

beforeAll(async () => {
  const bundle = `/* ${'x'.repeat(60_000)} */ document.querySelector('#app').textContent = 'booted';`;
  const files: Record<string, [string, string]> = {
    '/': ['text/html; charset=utf-8', `<!doctype html><html><head><base href="/"></head><body><p id="app">…</p><script src="main.js"></script></body></html>`],
    '/main.js': ['text/javascript', bundle],
  };
  upstream = createServer((req, res) => {
    const file = files[new URL(req.url ?? '/', 'http://upstream').pathname];
    if (!file) return void res.writeHead(404).end();
    const body = gzipSync(file[1]);
    res.writeHead(200, { 'content-type': file[0], 'content-encoding': 'gzip', 'content-length': body.length });
    res.end(body);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address() as AddressInfo;

  browser = await launch();
  host = await startHost({
    gateway: { registry: ['plans', 'goals'].map((id) => ({ id, endpoint: `http://127.0.0.1:${port}` })) },
    body: '<fragment-slot name="plans"></fragment-slot><fragment-slot name="goals"></fragment-slot>',
  });
});

afterAll(async () => {
  await browser?.close();
  await host?.close();
  await new Promise((resolve) => upstream?.close(resolve));
});

describe('a compressing upstream behind the Node gateway', () => {
  it(`boots every fragment on ${LOADS} direct loads`, async () => {
    const context = await browser.newContext();
    const failures: string[] = [];
    for (let load = 0; load < LOADS; load++) {
      const page = await context.newPage();
      page.on('requestfailed', (request) => failures.push(`${request.url()} ${request.failure()?.errorText}`));
      await page.goto(host.url);
      for (const name of ['plans', 'goals']) {
        const state = await page
          .waitForSelector(`fragment-slot[name="${name}"]:is([state="healthy"], [state="error"])`, { state: 'attached', timeout: 15_000 })
          .then((slot) => slot.getAttribute('state'));
        // `healthy` says the realm checked in, not that its external script has run: wait for that, a
        // little, rather than racing it (a realm that never boots still fails, as `…`)
        const text = await page
          .waitForFunction(
            (slotName) => {
              const content = document.querySelector(`fragment-slot[name="${slotName}"]`)?.shadowRoot?.querySelector('#app')?.textContent;
              return content === 'booted' ? content : null;
            },
            name,
            { timeout: 5_000 },
          )
          .then((handle) => handle.jsonValue())
          .catch(() =>
            page.evaluate(
              (slotName) => document.querySelector(`fragment-slot[name="${slotName}"]`)?.shadowRoot?.querySelector('#app')?.textContent,
              name,
            ),
          );
        if (state !== 'healthy' || text !== 'booted') failures.push(`load ${load}: ${name} ${state} ${text}`);
      }
      await page.close();
    }
    await context.close();
    console.log(`compressed upstream: ${LOADS} loads x 2 fragments, ${failures.length} failures`, failures.slice(0, 5));
    expect(failures).toEqual([]);
  });
});
