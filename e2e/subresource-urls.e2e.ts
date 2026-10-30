import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { endpoint, html, launch, readySlots, startHost, type Host } from './harness.js';
import { prepareFragmentHtml } from '../libs/braid-gateway/src/rewriter/transforms.js';
import { fragmentSubresourceUrl } from '../libs/core/src/compat/subresource-urls.js';

/**
 * URLs fragment script sets resolve exactly as the gateway resolves the same URLs in markup — on
 * any route, after navigation, and without prefixing a URL that is already re-rooted — and a
 * `once` message listener fires once although it listens on two windows.
 */

type Probe = { kind: string; detail?: unknown }[];

const fragment = `<!doctype html><html><head><base href="/"></head><body>
<img id="markup" src="logo.png">
<script>
  (function () {
    var log = function (kind, detail) { top.__probe.push({ kind: kind, detail: detail }); };
    var fromScript = document.createElement('img');
    fromScript.src = 'logo.png';
    document.body.appendChild(fromScript);
    log('markup', document.getElementById('markup').getAttribute('src'));
    log('script', fromScript.getAttribute('src'));

    var copy = document.createElement('img');
    copy.setAttribute('src', document.getElementById('markup').getAttribute('src'));
    log('copy', copy.getAttribute('src'));

    history.pushState(null, '', '/settings/deep/page');
    var later = document.createElement('img');
    later.src = 'logo.png';
    log('after-navigation', later.getAttribute('src'));

    var heard = 0;
    addEventListener('message', function () { heard++; }, { once: true });
    top.postMessage({ probe: 'to-host' }, '*');
    window.postMessage({ probe: 'to-self' }, '*');
    setTimeout(function () { log('once', heard); }, 300);
  })();
</script></body></html>`;

let browser: Browser;
let host: Host;
const requested: string[] = [];

beforeAll(async () => {
  browser = await launch();
  host = await startHost({
    gateway: {
      registry: [
        {
          id: 'u',
          endpoint: endpoint((path) => {
            requested.push(path);
            return path === '/logo.png' ? new Response('png', { headers: { 'content-type': 'image/png' } }) : html(fragment);
          }),
        },
      ],
    },
    head: '<script>window.__probe = [];</script>',
    body: '<fragment-slot name="u" src="/billing/invoices/42"></fragment-slot>',
  });
});

afterAll(async () => {
  await browser?.close();
  await host?.close();
});

describe('subresource URLs set from fragment script', () => {
  it("match the gateway's markup rule on a deep route, after navigation, and are never prefixed twice", async () => {
    const page = await browser.newPage();
    await page.goto(host.url);
    await readySlots(page, 'u');
    await page.waitForFunction(() => (window as unknown as { __probe: Probe }).__probe.some((e) => e.kind === 'once'));
    const probe = await page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);
    const value = (kind: string) => probe.find((e) => e.kind === kind)?.detail;

    expect(value('markup')).toBe('/__braid/frag/u/logo.png');
    expect(value('script')).toBe(value('markup'));
    expect(value('copy')).toBe(value('markup'));
    expect(value('after-navigation')).toBe(value('markup'));
    // the endpoint was asked for the path it would serve standalone, never a doubled one
    expect(requested.filter((path) => path.includes('logo'))).toEqual(expect.arrayContaining(['/logo.png']));
    expect(requested.some((path) => path.includes('__braid'))).toBe(false);
    await page.close();
  });

  it('fires a once message listener once, though it hears both windows', async () => {
    const page = await browser.newPage();
    await page.goto(host.url);
    await page.waitForFunction(() => (window as unknown as { __probe: Probe }).__probe.some((e) => e.kind === 'once'));
    expect(await page.evaluate(() => (window as unknown as { __probe: Probe }).__probe.find((e) => e.kind === 'once')?.detail)).toBe(1);
    await page.close();
  });

  it('agree with the gateway on a table of URLs and bases', async () => {
    const root = '/__braid/frag/u';
    const cases: [url: string, baseHref: string][] = [
      ['logo.png', '/'],
      ['/a/b.png', '/'],
      ['img/x.png?v=1#frag', '/app/'],
      ['../up.png', '/app/deep/'],
      ['/__braid/frag/u/already.png', '/'],
      ['https://cdn.example/x.png', '/'],
      ['//cdn.example/x.png', '/'],
    ];
    for (const [url, baseHref] of cases) {
      const markup = `<head><base href="${baseHref}"></head><body><img src="${url}"></body>`;
      const prepared = await new Response(
        prepareFragmentHtml(new Response(markup).body!, { fragmentId: 'u', basePath: '' }),
      ).text();
      const gateway = /<img src="([^"]*)"/.exec(prepared)?.[1];
      expect(fragmentSubresourceUrl(url, root, baseHref), `${url} @ ${baseHref}`).toBe(gateway);
    }
  });
});
