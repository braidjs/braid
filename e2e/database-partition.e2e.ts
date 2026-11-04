import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { endpoint, html, readySlots, startHost, type Host } from './harness.js';

/**
 * `capabilities.storage: { databases: true }`: each fragment's IndexedDB and Cache Storage are its
 * own. Run twice — with Storage Buckets (Chromium's default) and with them switched off, which
 * takes the prefixing path — and against two fragments without the grant, which share, to show the
 * test would notice.
 */

/** A fragment that, when the host says go, reads what is there, writes its own id, and reports. */
const recorder = (id: string) =>
  html(
    `<p id="out"></p><script>
      window.parent.addEventListener('go-${id}', async () => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('app', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('kv');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const before = await new Promise((resolve) => {
          const get = db.transaction('kv').objectStore('kv').get('who');
          get.onsuccess = () => resolve(get.result ?? null);
        });
        await new Promise((resolve) => {
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put('${id}', 'who');
          tx.oncomplete = resolve;
        });
        const cache = await caches.open('assets');
        const hit = await cache.match('/thing');
        const cachedBefore = hit ? await hit.text() : null;
        await cache.put('/thing', new Response('${id}'));
        const names = (await indexedDB.databases()).map((info) => info.name);
        db.close();
        document.getElementById('out').dataset.result = JSON.stringify({ before, cachedBefore, names });
      });
    </script>`,
  );

async function startStorageHost(): Promise<Host> {
  const own = { storage: { databases: true } } as const;
  return startHost({
    gateway: {
      registry: [
        { id: 'a', capabilities: own, endpoint: endpoint(() => recorder('a')) },
        { id: 'b', capabilities: own, endpoint: endpoint(() => recorder('b')) },
        { id: 'c', endpoint: endpoint(() => recorder('c')) },
        { id: 'd', endpoint: endpoint(() => recorder('d')) },
      ],
    },
    body: ['a', 'b', 'c', 'd'].map((id) => `<fragment-slot name="${id}"></fragment-slot>`).join(''),
  });
}

async function run(page: Page, id: string): Promise<{ before: string | null; cachedBefore: string | null; names: string[] }> {
  await page.evaluate((name) => window.dispatchEvent(new Event(`go-${name}`)), id);
  const out = await page.waitForFunction(
    (name) => document.querySelector(`fragment-slot[name="${name}"]`)!.shadowRoot!.querySelector('#out[data-result]'),
    id,
    { timeout: 10_000 },
  );
  return JSON.parse((await out.evaluate((element) => (element as HTMLElement).dataset['result'])) as string);
}

for (const [kind, args] of [
  ['with Storage Buckets', []],
  ['without Storage Buckets (prefixed names)', ['--disable-blink-features=StorageBuckets']],
] as const) {
  describe(`per-fragment databases, ${kind}`, () => {
    let browser: Browser;
    let host: Host;

    beforeAll(async () => {
      browser = await chromium.launch({ args: [...args] });
      host = await startStorageHost();
    });

    afterAll(async () => {
      await browser?.close();
      await host?.close();
    });

    it('keeps two fragments’ databases and caches apart, and out of the host’s', async () => {
      const page = await browser.newPage();
      await page.goto(host.url);
      await readySlots(page, 'a', 'b', 'c', 'd');
      expect(await page.evaluate(() => 'storageBuckets' in navigator)).toBe(args.length === 0);

      const a = await run(page, 'a');
      const b = await run(page, 'b');
      expect(a).toEqual({ before: null, cachedBefore: null, names: ['app'] });
      // b opened the same names a did, and found nothing of a's
      expect(b).toEqual({ before: null, cachedBefore: null, names: ['app'] });

      const hostView = await page.evaluate(async () => ({
        databases: (await indexedDB.databases()).map((info) => info.name),
        caches: await caches.keys(),
      }));
      expect(hostView.databases).not.toContain('app');
      expect(hostView.caches).not.toContain('assets');
      // which path ran: a bucket's databases are not the origin's at all; prefixed ones are, renamed
      if (args.length === 0) expect(hostView.databases.filter((name) => name?.startsWith('braid:'))).toEqual([]);
      else expect(hostView.databases).toEqual(expect.arrayContaining(['braid:a:app', 'braid:b:app']));

      // without the grant, the same two steps share one database: what the test exists to catch
      await run(page, 'c');
      expect((await run(page, 'd')).before).toBe('c');
      await page.close();
    });
  });
}
