import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { createRegistryApi, memorySnapshotStore, shellDocuments, snapshotRegistry, type ShellManifest } from '../libs/braid-registry/src/index.js';
import type { Workspace } from '../libs/braid-console/src/workspace.js';
import { bundleModule, launch, readySlots, startHost, type Host } from './harness.js';

/**
 * A shell designed with a workspace area, end to end in Chromium: published through the registry
 * API, served by the gateway from its definition, and used — an app launched into the area, the
 * layout saved, the page reloaded and the layout restored — with the fixed area beside it left
 * exactly as designed. No FDC3 agent is involved: the workspace is a feature of the page.
 */

const app = (id: string) => `<p>${id}</p><script>
  top.log = top.log || [];
  top.log.push('${id}:boot');
  braidDesktop.onSaveLayout(() => ({ note: top.notes && top.notes['${id}'] }));
  if (braidDesktop.restoredState !== undefined) top.log.push('${id}:restored:' + JSON.stringify(braidDesktop.restoredState));
</script>`;

const desk: ShellManifest = {
  id: 'desk',
  framework: 'vanilla',
  routes: [
    {
      path: '/desk',
      layout: { areas: 'nav work', columns: '200px 1fr', gap: '8px' },
      slots: { nav: 'nav' },
      workspace: { area: 'work', apps: ['notes'] },
    },
  ],
  head: { title: 'Desk' },
};

let browser: Browser;
let upstream: Server;
let host: Host;

beforeAll(async () => {
  browser = await launch();
  upstream = createServer((req, res) => {
    const id = /^\/(nav|notes|chart)\b/.exec(req.url ?? '')?.[1];
    res.writeHead(id ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' }).end(id ? app(id) : '');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  // the console's publish, as the registry API receives it
  const store = memorySnapshotStore();
  const api = createRegistryApi({ store, authorize: () => true });
  const published = await api.handle(
    new Request('http://console.test/__braid/registry-api/snapshots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifests: ['nav', 'notes', 'chart'].map((id) => ({ id, endpoint: `${origin}/${id}`, bound: false, src: '/' })),
        shells: [desk],
      }),
    }),
  );
  expect(published?.status, await published?.clone().text()).toBe(201);

  const registry = snapshotRegistry({ store });
  host = await startHost({
    gateway: { registry, documents: shellDocuments({ registry, runtimeSrc: '/runtime.js' }) },
    modules: { '/runtime.js': bundleModule('e2e/shell-workspace.runtime.ts') },
    body: '',
  });
});
afterAll(async () => {
  await browser?.close();
  await host?.close();
  await new Promise((resolve) => upstream?.close(resolve));
});

type Win = Window & { workspace: Workspace; log: string[]; notes: Record<string, string> };

async function open(): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (error) => console.error('page error:', error.message));
  await page.goto(`${host.url}desk`);
  await readySlots(page, 'nav', 'notes');
  return page;
}

const inWorkspace = (page: Page) =>
  page.locator('[data-braid-workspace] > fragment-slot').evaluateAll((slots) => slots.map((slot) => slot.getAttribute('name')));

describe('a served shell with a workspace area', () => {
  it('renders the fixed area and the workspace with its starting app, each in its grid area', async () => {
    const page = await open();
    expect(await page.title()).toBe('Desk');
    expect(await inWorkspace(page)).toEqual(['notes']);
    const placed = await page.evaluate(() => ({
      nav: getComputedStyle(document.querySelector('fragment-slot[name="nav"]')!).gridRowStart,
      work: getComputedStyle(document.querySelector('[data-braid-workspace]')!).gridRowStart,
      display: getComputedStyle(document.querySelector('[data-braid-workspace]')!).display,
      found: (window as unknown as Win).workspace.container === document.querySelector('[data-braid-workspace]'),
    }));
    expect(placed).toEqual({ nav: 'nav', work: 'work', display: 'flex', found: true });
    await page.context().close();
  });

  it('launches an app, saves the layout, and after a reload restores it in the area — the fixed area untouched', async () => {
    const page = await open();
    await page.evaluate(() => {
      const win = window as unknown as Win;
      win.workspace.open('chart', { props: { symbol: 'AAPL' } });
      win.notes = { chart: 'pinned', notes: 'draft 3' };
    });
    await readySlots(page, 'chart');
    expect(await inWorkspace(page)).toEqual(['notes', 'chart']);
    const saved = await page.evaluate(() => (window as unknown as Win).workspace.layouts.save('mine'));
    expect(saved.slots).toEqual([
      { appId: 'notes', src: '/', state: { note: 'draft 3' } },
      { appId: 'chart', props: { symbol: 'AAPL' }, state: { note: 'pinned' } },
    ]);

    await page.reload();
    await readySlots(page, 'nav', 'notes');
    // a reload is the shell as designed: the starting app only
    expect(await inWorkspace(page)).toEqual(['notes']);
    expect(await page.evaluate(() => (window as unknown as Win).workspace.layouts.list())).toEqual(['mine']);

    await page.evaluate(async () => {
      (document.querySelector('fragment-slot[name="nav"]') as Element & { marked?: boolean }).marked = true;
      await (window as unknown as Win).workspace.layouts.restore('mine');
    });
    await readySlots(page, 'notes', 'chart');
    expect(await inWorkspace(page)).toEqual(['notes', 'chart']);
    await page.waitForFunction(() => (window as unknown as Win).log.filter((entry) => entry.includes(':restored:')).length === 2);
    const after = await page.evaluate(() => {
      const nav = document.querySelector('fragment-slot[name="nav"]') as Element & { marked?: boolean };
      return {
        restored: (window as unknown as Win).log.filter((entry) => entry.includes(':restored:')).sort(),
        // the same element, still booted, still in its area: the restore never touched it
        navKept: nav.marked === true && nav.getAttribute('state'),
        navBoots: (window as unknown as Win).log.filter((entry) => entry === 'nav:boot').length,
        navArea: getComputedStyle(nav).gridRowStart,
        chartProps: (document.querySelector('fragment-slot[name="chart"]') as Element & { props?: unknown }).props,
        outside: [...document.querySelectorAll('.braid-shell > fragment-slot')].map((slot) => slot.getAttribute('name')),
      };
    });
    expect(after.restored).toEqual(['chart:restored:{"note":"pinned"}', 'notes:restored:{"note":"draft 3"}']);
    expect(['ready', 'healthy']).toContain(after.navKept);
    expect(after).toMatchObject({ navBoots: 1, navArea: 'nav', chartProps: { symbol: 'AAPL' }, outside: ['nav'] });
    await page.context().close();
  });
});
