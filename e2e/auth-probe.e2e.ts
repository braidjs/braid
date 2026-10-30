import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { endpoint, html, launch, readySlots, startHost, type Host } from './harness.js';

/**
 * What a real browser does today when two trusted fragments each run their own auth client.
 *
 * These pinned the behaviour as measured, and are the evidence behind
 * docs/multi-issuer-auth-plan.md. The storage tests still describe shared fragments (partitioned
 * ones are e2e/storage-partition.e2e.ts); the message tests were flipped by the P4 fix.
 */

type Probe = { fragment: string; kind: string; detail?: unknown }[];

/** A fragment that behaves like an OIDC client with the library's default storage keys. */
function oidcFragment(id: string, issuer: string): string {
  return `<p>${id}</p><script>
  (function () {
    var log = function (kind, detail) { top.__probe.push({ fragment: '${id}', kind: kind, detail: detail }); };
    var own = Object.getOwnPropertyDescriptor(window, 'localStorage');
    log('descriptor', { own: !!own, configurable: !!(own && own.configurable), accessor: !!(own && own.get) });
    addEventListener('storage', function (e) { log('storage-event', { key: e.key, newValue: e.newValue }); });
    window.onstorage = function (e) { log('onstorage', { key: e.key }); };
    localStorage.setItem('okta-token-storage', JSON.stringify({ issuer: '${issuer}' }));
    sessionStorage.setItem('okta-transaction-storage', '${issuer}');
    top.__ready = (top.__ready || 0) + 1;
  })();
</script>`;
}

/** A fragment exercising the four ways a cross-frame auth reply can arrive. */
const messagingFragment = `<p>messaging</p><script>
  (function () {
    var log = function (kind, detail) { top.__probe.push({ fragment: 'msg', kind: kind, detail: detail }); };
    addEventListener('message', function (e) { if (e.data && e.data.probe) log('listener', e.data.probe); });
    window.onmessage = function (e) { if (e.data && e.data.probe) log('onmessage', e.data.probe); };

    // (a, b) a hidden auth iframe in the fragment's DOM that replies to its parent
    var frame = document.createElement('iframe');
    frame.style.display = 'none';
    frame.src = '/__braid/frag/msg/reply-parent.html';
    document.body.appendChild(frame);

    // a relative src, as a silent-renew redirect_uri often is: where does it resolve?
    var relative = document.createElement('iframe');
    relative.style.display = 'none';
    relative.src = 'reply-relative.html';
    document.body.appendChild(relative);
    log('relative-src', relative.src);

    // (c) a popup that replies to its opener
    var popup = window.open('/__braid/frag/msg/reply-opener.html');
    log('popup-opened', !!popup);

    // (d) a message to itself
    window.postMessage({ probe: 'self' }, '*');
  })();
</script>`;

const replyParent = `<script>parent.postMessage({ probe: 'iframe-to-parent' }, '*')</script>`;
const replyOpener = `<script>opener && opener.postMessage({ probe: 'popup-to-opener' }, '*'); setTimeout(close, 50)</script>`;

let browser: Browser;
let host: Host;

beforeAll(async () => {
  browser = await launch();
  host = await startHost({
    gateway: {
      registry: [
        { id: 'a', endpoint: endpoint(() => html(oidcFragment('a', 'https://issuer-a.example'))) },
        { id: 'b', endpoint: endpoint(() => html(oidcFragment('b', 'https://issuer-b.example'))) },
        {
          id: 'msg',
          endpoint: endpoint((path) => {
            if (path.endsWith('/reply-parent.html')) return html(replyParent);
            if (path.endsWith('/reply-relative.html')) return html(`<script>parent.postMessage({ probe: 'relative' }, '*')</script>`);
            if (path.endsWith('/reply-opener.html')) return html(replyOpener);
            return html(messagingFragment);
          }),
        },
      ],
    },
    head: `<script>window.__probe = []; addEventListener('storage', function (e) { __probe.push({ fragment: 'host', kind: 'storage-event', detail: { key: e.key } }); });</script>`,
    body: '<fragment-slot name="a"></fragment-slot><fragment-slot name="b"></fragment-slot><fragment-slot name="msg"></fragment-slot>',
  });
});

afterAll(async () => {
  await browser?.close();
  await host?.close();
});

async function run(): Promise<{ page: Page; probe: Probe }> {
  const page = await browser.newPage();
  await page.goto(host.url);
  await readySlots(page, 'a', 'b', 'msg');
  // storage events and cross-frame messages are delivered as tasks after the writes
  await page.waitForTimeout(1_000);
  const probe = await page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);
  return { page, probe };
}

const find = (probe: Probe, fragment: string, kind: string) =>
  probe.filter((entry) => entry.fragment === fragment && entry.kind === kind);

describe('two fragments with different issuers on one page, today', () => {
  it('can override storage per realm: localStorage is an own, configurable accessor on the realm window', async () => {
    const { probe } = await run();
    for (const fragment of ['a', 'b']) {
      expect(find(probe, fragment, 'descriptor')[0]?.detail).toEqual({ own: true, configurable: true, accessor: true });
    }
  });

  it('collides on the library default keys: the last writer wins for everyone', async () => {
    const { page } = await run();
    const stored = await page.evaluate(() => ({
      token: JSON.parse(localStorage.getItem('okta-token-storage') ?? '{}').issuer,
      transaction: sessionStorage.getItem('okta-transaction-storage'),
    }));
    // one value for both fragments, whichever booted last
    expect(['https://issuer-a.example', 'https://issuer-b.example']).toContain(stored.token);
    expect(stored.transaction).toBe(stored.token);
  });

  it("delivers one fragment's storage writes to the other fragment's listener", async () => {
    const { probe } = await run();
    const seenByA = find(probe, 'a', 'storage-event').map((e) => (e.detail as { key: string }).key);
    const seenByB = find(probe, 'b', 'storage-event').map((e) => (e.detail as { key: string }).key);
    // each realm hears the other's write of the shared key — this is how a sync listener clobbers
    expect([...seenByA, ...seenByB]).toContain('okta-token-storage');
  });

  it("fires window.onstorage natively for another fragment's writes", async () => {
    // The browser fires storage events at every same-origin window but the writer's, realm windows
    // included — so a partition has to filter there as well as on the host-window relay.
    const { probe } = await run();
    const keys = [...find(probe, 'a', 'onstorage'), ...find(probe, 'b', 'onstorage')].map((e) => (e.detail as { key: string }).key);
    expect(keys).toContain('okta-token-storage');
  });

  // Fixed by P4: every reply reaches both listener styles exactly once, wherever it lands.
  const count = (values: unknown[], value: string) => values.filter((v) => v === value).length;

  it('delivers a hidden auth iframe reply to addEventListener and to window.onmessage, once each', async () => {
    const { probe } = await run();
    for (const style of ['listener', 'onmessage']) {
      expect(count(find(probe, 'msg', style).map((e) => e.detail), 'iframe-to-parent'), style).toBe(1);
    }
  });

  it("resolves a realm-created iframe's relative src against the fragment, so its reply arrives", async () => {
    const { probe } = await run();
    expect(find(probe, 'msg', 'relative-src')[0]?.detail).toMatch(/\/__braid\/frag\/msg\/reply-relative\.html$/);
    expect(count(find(probe, 'msg', 'listener').map((e) => e.detail), 'relative')).toBe(1);
  });

  it('delivers popup replies to opener and self-posts to both listener styles, once each', async () => {
    const { probe } = await run();
    for (const style of ['listener', 'onmessage']) {
      const delivered = find(probe, 'msg', style).map((e) => e.detail);
      expect(count(delivered, 'popup-to-opener'), style).toBe(1);
      expect(count(delivered, 'self'), style).toBe(1);
    }
  });
});
