import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { endpoint, html, launch, readySlots, startHost, type Host } from './harness.js';

/**
 * `capabilities.storage` in a real browser: the collisions auth-probe.e2e.ts pins for shared
 * fragments do not happen to partitioned ones, and fragments naming one partition still share it.
 */

type Probe = { fragment: string; kind: string; detail?: unknown }[];

/** An OIDC-like client: default keys, a storage listener of each kind, all from its first script. */
function client(id: string, issuer: string): string {
  return `<p>${id}</p><script>
  (function () {
    var log = function (kind, detail) { top.__probe.push({ fragment: '${id}', kind: kind, detail: detail }); };
    addEventListener('storage', function (e) {
      log('listener', { key: e.key, newValue: e.newValue, ownArea: e.storageArea === localStorage || e.storageArea === sessionStorage });
    });
    window.onstorage = function (e) { log('onstorage', { key: e.key }); };
    localStorage.setItem('okta-token-storage', '${issuer}');
    sessionStorage.setItem('okta-transaction-storage', '${issuer}');
    log('read-own', localStorage.getItem('okta-token-storage'));
  })();
</script>`;
}

let browser: Browser;
let host: Host;

beforeAll(async () => {
  browser = await launch();
  const fragment = (id: string, issuer: string, storage?: unknown) => ({
    id,
    endpoint: endpoint(() => html(client(id, issuer))),
    ...(storage === undefined ? {} : { capabilities: { storage } as never }),
  });
  host = await startHost({
    gateway: {
      registry: [
        fragment('a', 'issuer-a', 'partitioned'),
        fragment('b', 'issuer-b', 'partitioned'),
        fragment('c', 'issuer-kcd', { partition: 'kcd' }),
        fragment('d', 'issuer-kcd-2', { partition: 'kcd' }),
      ],
    },
    head: `<script>window.__probe = [];</script>`,
    body: ['a', 'b', 'c', 'd'].map((id) => `<fragment-slot name="${id}"></fragment-slot>`).join(''),
  });
});

afterAll(async () => {
  await browser?.close();
  await host?.close();
});

async function run(): Promise<{ page: Page; probe: Probe }> {
  const page = await browser.newPage();
  await page.goto(host.url);
  await readySlots(page, 'a', 'b', 'c', 'd');
  await page.waitForTimeout(1_000);
  return { page, probe: await page.evaluate(() => (window as unknown as { __probe: Probe }).__probe) };
}

const find = (probe: Probe, fragment: string, kind: string) =>
  probe.filter((entry) => entry.fragment === fragment && entry.kind === kind).map((entry) => entry.detail);

describe('partitioned fragments', () => {
  it('each keep their own value under the default key, from their very first script', async () => {
    const { page, probe } = await run();
    expect(find(probe, 'a', 'read-own')).toEqual(['issuer-a']);
    expect(find(probe, 'b', 'read-own')).toEqual(['issuer-b']);

    const store = await page.evaluate(() => ({
      host: localStorage.getItem('okta-token-storage'),
      a: localStorage.getItem('braid:storage:a:okta-token-storage'),
      b: localStorage.getItem('braid:storage:b:okta-token-storage'),
      aTransaction: sessionStorage.getItem('braid:storage:a:okta-transaction-storage'),
      hostIsNative: Object.getPrototypeOf(localStorage) === Storage.prototype,
    }));
    expect(store).toEqual({ host: null, a: 'issuer-a', b: 'issuer-b', aTransaction: 'issuer-a', hostIsNative: true });
  });

  it("never hear each other's writes, through addEventListener or onstorage", async () => {
    const { probe } = await run();
    for (const id of ['a', 'b']) {
      expect(find(probe, id, 'listener'), `${id} listener`).toEqual([]);
      expect(find(probe, id, 'onstorage'), `${id} onstorage`).toEqual([]);
    }
  });
});

describe('a named partition', () => {
  it('is shared by the fragments that name it, which hear each other with their own key names', async () => {
    const { page, probe } = await run();
    const [cValue, dValue] = await page.evaluate(() => [
      localStorage.getItem('braid:storage:kcd:okta-token-storage'),
      localStorage.getItem('braid:storage:c:okta-token-storage'),
    ]);
    // one store for both: the later boot's write is the value both now read
    expect(['issuer-kcd', 'issuer-kcd-2']).toContain(cValue);
    expect(dValue).toBeNull();

    // whichever wrote first hears the other's write, unprefixed and against its own view
    const heard = [...find(probe, 'c', 'listener'), ...find(probe, 'd', 'listener')] as { key: string; ownArea: boolean }[];
    expect(heard.map((e) => e.key)).toContain('okta-token-storage');
    expect(heard.every((e) => e.ownArea)).toBe(true);
    // and, as natively, never its own writes
    expect(find(probe, 'c', 'listener').map((e) => (e as { newValue: string }).newValue)).not.toContain('issuer-kcd');
    expect(find(probe, 'd', 'listener').map((e) => (e as { newValue: string }).newValue)).not.toContain('issuer-kcd-2');
    const handlers = [...find(probe, 'c', 'onstorage'), ...find(probe, 'd', 'onstorage')] as { key: string }[];
    expect(handlers.map((e) => e.key)).toContain('okta-token-storage');
  });

  it('is not visible to a fragment in another partition', async () => {
    const { probe } = await run();
    expect(find(probe, 'a', 'listener')).toEqual([]);
    expect(find(probe, 'a', 'read-own')).toEqual(['issuer-a']);
  });
});
