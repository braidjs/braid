import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { bundleModule, launch, readySlots } from './harness.js';

/**
 * The console on a static host, with the service-worker gateway as its only backend.
 *
 * The server below knows nothing of Braid: it serves files, and 404s anything under /__braid/.
 * Everything the console asks for — the discovery listing behind Fragments and Topology, and the
 * registry write API behind Shells — is answered by the worker in console-sw.worker.ts, and a
 * shell published from the console is then served by the gateway in that same worker.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

const consolePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Console</title></head><body>
<script type="application/json" id="braid-console-config">{ "edit": true }</script>
<div id="root"></div>
<script type="module">
  // nothing answers /__braid/ until the worker controls the page, so the console starts after it does
  if (!navigator.serviceWorker.controller) {
    const controlled = new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    await navigator.serviceWorker.register('/sw.js', { type: 'module', scope: '/' });
    await controlled;
  }
  await import('/console/app.js');
</script></body></html>`;

const app = (id: string) => `<!doctype html><p id="who">${id} app</p>`;

let browser: Browser;
let server: Server;
let url: string;
/** Every /__braid/ path that reached the static server instead of the worker. */
const leaked: string[] = [];

beforeAll(async () => {
  browser = await launch();
  const consoleApp = build({
    entryPoints: [`${root}libs/braid-console/src/app/main.tsx`],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    write: false,
    tsconfig: `${root}tsconfig.base.json`,
    logLevel: 'silent',
  }).then((result) => result.outputFiles[0].text);
  const scripts: Record<string, Promise<string>> = {
    '/console/app.js': consoleApp,
    '/sw.js': bundleModule('e2e/console-sw.worker.ts'),
    '/runtime.js': bundleModule('e2e/console-sw.runtime.ts'),
  };
  await Promise.all(Object.values(scripts));

  server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://static');
    if (pathname.startsWith('/__braid/')) {
      leaked.push(pathname);
      res.writeHead(404).end();
    } else if (scripts[pathname]) {
      void scripts[pathname].then((source) => res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }).end(source));
    } else if (pathname === '/attacker.html') {
      // another site's page: a form needs no CORS, and text/plain lets it shape a JSON body
      const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__braid/registry-api/snapshots`;
      const name = '{"manifests":[{"id":"evil","endpoint":"https://evil.example/"}],"ignored":"';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        `<!doctype html><form method="POST" enctype="text/plain" action="${target}"><input name='${name}' value='"}'></form>`,
      );
    } else if (pathname === '/console/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(consolePage);
    } else if (/^\/apps\/(notes|chart)\//.test(pathname)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(app(pathname.split('/')[2]));
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('static server: no such file');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

async function openConsole(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error('page error:', error.message));
  await page.goto(`${url}console/`);
  await page.getByRole('tab', { name: 'Fragments', exact: true }).waitFor({ timeout: 15_000 });
  return page;
}

describe('the console on a static host, behind the service-worker gateway', () => {
  it('lists the registry in Fragments and maps it in Topology, from the worker alone', async () => {
    const context = await browser.newContext();
    const page = await openConsole(context);

    await expect.poll(() => page.locator('body').innerText()).toContain('notes');
    expect(await page.locator('body').innerText()).toContain('chart');

    await page.getByRole('tab', { name: 'Topology' }).click();
    await expect.poll(() => page.locator('svg').first().textContent()).toContain('notes');

    expect(leaked).toEqual([]);
    await context.close();
  });

  it('designs and publishes a shell through the worker, which then serves it — still there after the worker restarts', async () => {
    const context = await browser.newContext();
    const page = await openConsole(context);

    await page.getByRole('tab', { name: 'Shells' }).click();
    await page.getByRole('button', { name: 'New shell' }).click();
    await page.locator('label', { hasText: 'Framework' }).locator('select').selectOption('vanilla');
    await page.getByRole('button', { name: /^Area main/ }).click();
    await page.locator('label', { hasText: 'Fragment in' }).locator('select').selectOption('notes');
    await page.getByRole('button', { name: 'Publish & pin' }).click();
    await expect.poll(() => page.locator('body').innerText(), { timeout: 15_000 }).toMatch(/Published reg_\w+ and pinned/);

    // History reads the same store back
    await page.getByRole('tab', { name: 'History' }).click();
    await expect.poll(() => page.locator('tbody tr').count()).toBeGreaterThanOrEqual(2);

    const served = await page.goto(`${url}new-shell`);
    expect(served?.status()).toBe(200);
    expect(served?.fromServiceWorker()).toBe(true);
    expect(await served!.text()).toContain('<div class="braid-shell">');
    await readySlots(page, 'notes');
    expect(await page.locator('fragment-slot[name="notes"]').getAttribute('data-braid-area')).toBe('main');

    // a worker is stopped whenever it is idle: what it published has to outlive it
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    const again = await page.reload();
    expect(again?.status()).toBe(200);
    expect(again?.fromServiceWorker()).toBe(true);
    await readySlots(page, 'notes');

    expect(leaked).toEqual([]);
    await context.close();
  });

  it('refuses a publish forged by another site: a form posted into the worker\u2019s scope', async () => {
    const context = await browser.newContext();
    const page = await openConsole(context);
    const fragments = () => page.evaluate(async () => ((await (await fetch('/__braid/registry')).json()) as { items: { id: string }[] }).items.map((item) => item.id));
    const before = await fragments();
    expect(before).toContain('notes');

    // the same server on another host name is another origin, and another site
    const attacker = await context.newPage();
    await attacker.goto(`${url.replace('127.0.0.1', 'localhost')}attacker.html`);
    const [response] = await Promise.all([attacker.waitForNavigation(), attacker.evaluate(() => document.querySelector('form')!.submit())]);
    expect(response?.fromServiceWorker()).toBe(true);
    expect(response?.status()).toBe(403);

    expect(await fragments()).toEqual(before);
    expect(leaked).toEqual([]);
    await context.close();
  });
});
