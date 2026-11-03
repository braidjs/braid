import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import {
  endpoint,
  html,
  launch,
  readySlots,
  startHost,
  type Host,
} from './harness.js';

/**
 * Angular's critical-CSS output (before 22.2) loads the global stylesheet as `media="print"` and
 * switches it to `all` once it loads: with an `onload` handler, which the gateway strips, or — when
 * a CSP nonce is set — with an `ngCspMedia` attribute that a nonce'd script copies across on the
 * document's load events. That script runs only once the fragment's realm boots, so a sheet that
 * loads first is never promoted; a loopback sheet always wins that race, which is the side this
 * reproduces. Either way the sheet must still apply.
 */

let browser: Browser;
// one host per case: on a shared page, one slot's outcome must not stand in for the other's
const hosts: Record<string, Host> = {};

const DEFERRED_LINKS = {
  onload: `<link rel="stylesheet" href="styles.css" media="print" onload="this.media='all'">`,
  // what @angular/build 22.1 writes with ngCspNonce or autoCsp, script included
  csp:
    `<link rel="stylesheet" href="styles.css" media="print" ngCspMedia="all">` +
    `<script nonce="n0nce">(() => { const CSP_MEDIA_ATTR = 'ngCspMedia'; const documentElement = document.documentElement; ` +
    `const listener = (e) => { const target = e.target; ` +
    `if (!target || target.tagName !== 'LINK' || !target.hasAttribute(CSP_MEDIA_ATTR)) { return; } ` +
    `target.media = target.getAttribute(CSP_MEDIA_ATTR); target.removeAttribute(CSP_MEDIA_ATTR); ` +
    `if (!document.head.querySelector(\`link[\${CSP_MEDIA_ATTR}]\`)) { documentElement.removeEventListener('load', listener); } }; ` +
    `documentElement.addEventListener('load', listener, true); })();</script>`,
};

const app = (variant: keyof typeof DEFERRED_LINKS) =>
  endpoint((path) =>
    path.endsWith('/styles.css')
      ? new Response('h1 { color: rgb(1, 2, 3); }', {
          headers: { 'content-type': 'text/css' },
        })
      : html(
          `<!doctype html><html><head><base href="/">` +
            DEFERRED_LINKS[variant] +
            // Angular also emits a <noscript> copy of the link. Left out: on the composed path the
            // client parses with DOMParser, where scripting is off, so that copy would apply and hide
            // whether the deferred link itself works. On a pierced page it is inert text.

            `</head><body><h1 id="title">styled</h1></body></html>`,
        ),
  );

const CASES = (['onload', 'csp'] as const).flatMap((variant) =>
  (['composed', 'pierced'] as const).map((mode) => ({
    variant,
    mode,
    name: `${mode}-${variant}`,
  })),
);

beforeAll(async () => {
  browser = await launch();
  for (const { variant, mode, name } of CASES) {
    hosts[name] = await startHost({
      gateway: {
        registry: [
          {
            id: name,
            endpoint: app(variant),
            ...(mode === 'pierced' ? { pierce: ['/'] } : {}),
          },
        ],
      },
      body: `<fragment-slot name="${name}"></fragment-slot>`,
    });
  }
});

afterAll(async () => {
  await browser?.close();
  await Promise.all(Object.values(hosts).map((host) => host.close()));
});

describe('a deferred stylesheet', () => {
  it.each(CASES)('applies in a $mode fragment ($variant)', async ({ name }) => {
    const page = await browser.newPage();
    await page.goto(hosts[name].url);
    await readySlots(page, name);
    const color = await page.waitForFunction(
      (slotName) => {
        const title = document
          .querySelector(`fragment-slot[name="${slotName}"]`)
          ?.shadowRoot?.querySelector('#title');
        const value = title && getComputedStyle(title).color;
        return value === 'rgb(1, 2, 3)' ? value : null;
      },
      name,
      { timeout: 10_000 },
    );
    expect(await color.jsonValue()).toBe('rgb(1, 2, 3)');
    await page.close();
  });
});
