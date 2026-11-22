import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostileCases, random, REVIEW_CASES } from '../libs/braid-gateway/testing/hostile-markup.js';
import { prepareFragmentHtml as legacyPrepareFragmentHtml } from '../libs/braid-gateway/testing/legacy-transforms.js';
import { prepareFragmentHtml } from '../libs/braid-gateway/src/rewriter/transforms.js';
import { endpoint, html, launch, readySlots, startHost, type Host } from './harness.js';

/**
 * The gateway's rewriter against Chromium: hostile fragments prepared at random splits, then parsed
 * by a real page in both contexts fragment markup reaches.
 *
 * - **Pierced**: inside `<template shadowrootmode="open"><braid-document>` in a page loaded over
 *   HTTP, with host markup after each fragment that must come through intact.
 * - **Fetched**: inside `<braid-document>` in a template, as `parseFragmentContent` parses it, then
 *   moved into the live page as the client does.
 *
 * Every payload calls `pwn(id)` if it runs. A case fails if anything runs, navigates or preloads,
 * if anything the transforms remove is in the DOM, or if anything leaves the element it was placed
 * in. Chromium parses `<select>` as customizable select does; the unit differential runs the same
 * cases through parse5, which parses it as older browsers do.
 */

const PER_PAGE = 100;

function streamOf(markup: string, splits: number[] = []): ReadableStream<Uint8Array> {
  const cuts = [...new Set(splits)].filter((cut) => cut > 0 && cut < markup.length).sort((a, b) => a - b);
  const pieces = [0, ...cuts, markup.length].slice(1).map((end, index, ends) => markup.slice(index ? ends[index - 1] : 0, end));
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece));
      controller.close();
    },
  });
}

const prepare = (markup: string, splits?: number[]) =>
  new Response(prepareFragmentHtml(streamOf(markup, splits), { fragmentId: 'f' })).text();
const legacyPrepare = (markup: string) =>
  new Response(legacyPrepareFragmentHtml(streamOf(markup), { fragmentId: 'f' })).text();

/** One page of prepared fragments, each pierced into a slot with a sentinel after it. */
function page(outputs: string[]): string {
  const slots = outputs
    .map(
      (output, index) =>
        `<fragment-slot id="s${index}"><template shadowrootmode="open"><braid-document>${output}</braid-document>` +
        `</template></fragment-slot><p class="braid-sentinel" id="t${index}">after</p>`,
    )
    .join('');
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<script>window.__pwned = []; window.pwn = (id) => window.__pwned.push(String(id));</script>` +
    `</head><body>${slots}<div id="live"></div></body></html>`
  );
}

let browser: Browser;
let server: Server;
let origin: string;
const pages = new Map<string, string>();
/** Requests a live preload would make: the payloads' `/p/<id>`, namespaced or not. */
const preloads: string[] = [];

beforeAll(async () => {
  browser = await launch();
  server = createServer((request, response) => {
    const path = request.url ?? '/';
    if (/\/p\/\d+/.test(path)) preloads.push(path);
    const body = pages.get(path);
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

/** What is wrong with each fragment on a page, by index, after both parses and a moment to run. */
async function check(outputs: string[]): Promise<Map<number, string[]>> {
  const path = `/page/${pages.size}`;
  pages.set(path, page(outputs));
  preloads.length = 0;
  const tab: Page = await browser.newPage();
  let navigated = 0;
  tab.on('framenavigated', (frame) => {
    if (frame === tab.mainFrame()) navigated++;
  });
  await tab.goto(`${origin}${path}`, { waitUntil: 'load' });
  await tab.waitForTimeout(150);

  const found = await tab.evaluate((fragments): string[][] => {
    const problems: string[][] = fragments.map(() => []);
    const HTML = 'http://www.w3.org/1999/xhtml';
    const loadsByUrl = (raw: string | null) => {
      if (raw === null) return true;
      const url = raw.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').toLowerCase();
      const scheme = /^([a-z][a-z0-9+.-]*):/.exec(url)?.[1];
      return scheme === undefined || scheme === 'http' || scheme === 'https' || url === 'about:blank';
    };
    const checkElement = (element: Element, report: (problem: string) => void) => {
      for (const { name } of element.attributes) if (/^on[a-z]+$/.test(name)) report(`<${element.localName}> ${name}`);
      if (element.localName === 'script' && element.getAttribute('type') !== 'inert') report('a live script');
      if (element.namespaceURI !== HTML) return;
      const name = element.localName;
      if (name === 'iframe' && (element.hasAttribute('srcdoc') || !loadsByUrl(element.getAttribute('src')))) report('an inline frame');
      if (name === 'embed' && !loadsByUrl(element.getAttribute('src'))) report('an inline embed');
      if (name === 'object' && !loadsByUrl(element.getAttribute('data'))) report('an inline object');
      if (name === 'meta' && element.getAttribute('http-equiv')?.trim().toLowerCase() === 'refresh') report('a meta refresh');
      if (name === 'link' && /(^|\s)(preload|prefetch|modulepreload)(\s|$)/i.test(element.getAttribute('rel') ?? '')) report('a live preload');
    };
    const walk = (root: ParentNode, report: (problem: string) => void) => {
      for (const element of root.querySelectorAll('*')) {
        checkElement(element, report);
        if (element instanceof HTMLTemplateElement) walk(element.content, report);
        if (element.shadowRoot) walk(element.shadowRoot, report);
      }
    };

    // pierced
    const body = document.body;
    if (body.children.length !== fragments.length * 2 + 1) problems[0].push(`the page has ${body.children.length} elements in <body>`);
    for (const [index] of fragments.entries()) {
      const report = (problem: string) => problems[index].push(`pierced: ${problem}`);
      const slot = document.getElementById(`s${index}`);
      const sentinel = document.getElementById(`t${index}`);
      if (!slot || slot.parentElement !== body) report('the slot moved');
      if (!sentinel || sentinel.parentElement !== body || slot?.nextElementSibling !== sentinel) report('the host markup after it changed');
      if (sentinel && (sentinel.textContent !== 'after' || sentinel.children.length)) report('the host markup after it was wrapped');
      if (!slot?.shadowRoot) {
        report('no shadow root');
        continue;
      }
      if (slot.childNodes.length) report('markup in the slot’s light DOM');
      const roots = [...slot.shadowRoot.children].map((child) => child.localName);
      if (roots.join() !== 'braid-document') report(`markup outside braid-document: ${roots.join()}`);
      walk(slot.shadowRoot, report);
    }

    // fetched: parsed as parseFragmentContent parses, then live in the page
    const live = document.getElementById('live')!;
    for (const [index, output] of fragments.entries()) {
      const report = (problem: string) => problems[index].push(`fetched: ${problem}`);
      const outer = document.createElement('template');
      outer.innerHTML = `<template><braid-document>${output}</braid-document></template>`;
      const inner = outer.content.firstElementChild;
      if (outer.content.children.length !== 1 || !(inner instanceof HTMLTemplateElement)) {
        report('something escaped the template');
        continue;
      }
      const roots = [...inner.content.children];
      if (roots.map((child) => child.localName).join() !== 'braid-document') report('markup outside braid-document');
      walk(inner.content, report);
      const box = document.createElement('div');
      box.append(...[...roots[0].childNodes].map((node) => document.importNode(node, true)));
      live.append(box);
    }
    return problems;
  }, outputs).catch((): string[][] => [['the page navigated away before it could be checked']]);

  await tab.waitForTimeout(150);
  // a page a meta refresh replaced has no record at all
  const pwned = await tab
    .evaluate(() => (window as unknown as { __pwned?: string[] }).__pwned ?? ['(the page was replaced)'])
    .catch(() => ['(the page was replaced)']);
  await tab.close();

  const byIndex = new Map<number, string[]>();
  for (const [index, problems] of found.entries()) if (problems.length) byIndex.set(index, problems);
  const pageWide = [
    ...(pwned.length ? [`ran: pwn(${pwned.join(', ')})`] : []),
    ...(navigated > 1 ? ['the page navigated'] : []),
    ...(preloads.length ? [`preloaded ${preloads.join(', ')}`] : []),
  ];
  if (pageWide.length) byIndex.set(-1, pageWide);
  return byIndex;
}

/** Checks cases a page at a time; a page with something wrong is checked again one case at a time. */
async function failures(cases: string[], outputs: string[]): Promise<string[]> {
  const found: string[] = [];
  for (let start = 0; start < cases.length && found.length < 10; start += PER_PAGE) {
    const batch = outputs.slice(start, start + PER_PAGE);
    if (!(await check(batch)).size) continue;
    for (const [offset, output] of batch.entries()) {
      const problems = await check([output]);
      if (problems.size) {
        found.push(`${JSON.stringify(cases[start + offset])}\n  -> ${JSON.stringify(output)}\n  ${[...problems.values()].flat().join('\n  ')}`);
      }
    }
  }
  return found;
}

describe('prepared fragments in Chromium', () => {
  it('the review’s cases: nothing runs, nothing is left live, nothing gets out', async () => {
    const cases = Object.values(REVIEW_CASES);
    const outputs = await Promise.all(cases.map((markup) => prepare(markup)));
    expect((await failures(cases, outputs)).join('\n\n')).toBe('');
  });

  it('and through the old rewriter, Chromium shows them live', async () => {
    const cases = Object.entries(REVIEW_CASES);
    const live: string[] = [];
    for (const [name, markup] of cases) if ((await check([await legacyPrepare(markup)])).size) live.push(name);
    // customizable select parses raw text in a select as raw text, so that case is live only in older parsers
    expect(cases.map(([name]) => name).filter((name) => !live.includes(name))).toEqual(['select with raw text old parsers ignore']);
  });

  it('generated hostile fragments, split at random: nothing runs, nothing is left live, nothing gets out', async () => {
    const cases = hostileCases(Number(process.env.BRAID_FUZZ_CASES ?? 2000), Number(process.env.BRAID_FUZZ_SEED ?? 20261123));
    const next = random(31);
    const outputs = await Promise.all(
      cases.map((markup) => prepare(markup, Array.from({ length: 1 + Math.floor(next() * 4) }, () => Math.floor(next() * markup.length)))),
    );
    expect((await failures(cases, outputs)).join('\n\n')).toBe('');
  }, 600_000);
});

describe('a fetched fragment parses where a pierced one does', () => {
  let host: Host;
  const snippet = '<style>#styled { color: rgb(1, 2, 3) }</style><p id="styled">styled</p>';

  beforeAll(async () => {
    host = await startHost({
      gateway: {
        registry: [
          { id: 'composed', endpoint: endpoint(() => html(snippet)) },
          { id: 'pierced', pierce: ['/'], endpoint: endpoint(() => html(snippet)) },
        ],
      },
      body: '<fragment-slot name="composed"></fragment-slot><fragment-slot name="pierced"></fragment-slot>',
    });
  });

  afterAll(async () => {
    await host?.close();
  });

  it.each(['composed', 'pierced'])('a bare snippet keeps its leading <style> (%s)', async (name) => {
    const tab = await browser.newPage();
    await tab.goto(host.url);
    await readySlots(tab, name);
    const color = await tab.waitForFunction(
      (slot) => {
        const styled = document.querySelector(`fragment-slot[name="${slot}"]`)?.shadowRoot?.querySelector('#styled');
        const value = styled && getComputedStyle(styled).color;
        return value === 'rgb(1, 2, 3)' ? value : null;
      },
      name,
      { timeout: 10_000 },
    );
    expect(await color.jsonValue()).toBe('rgb(1, 2, 3)');
    await tab.close();
  });
});
