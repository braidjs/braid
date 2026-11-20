import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launch } from './harness.js';
import { build } from '../examples/concierge/build.mjs';
import { start } from '../examples/concierge/server.mjs';
import { A2UI_LIMITS, parseA2uiMessage } from '../libs/sdui/src/a2ui.js';

/**
 * What an agent can make a page do by sending a lot: every stream the verification rounds used to
 * freeze or crash the renderer, at the scale that did it, drawn by `<a2ui-surface>` in the
 * Concierge example. Each message is within A2UI_LIMITS — the parser accepts it — so what stands
 * between it and the page is the renderer's budgets. The page must stay responsive (no main-thread
 * gap over BLOCK_MS), not crash, and tell the agent only a bounded number of times.
 */

const BLOCK_MS = 300;
/** The most values one message may carry, less room for the rest of it: each case is as large as a message may be. */
const V = A2UI_LIMITS.values - 1_000;
/** Errors an element may POST however much is wrong: its burst, and what refills during a test. */
const MAX_POSTS = 60;

const tsconfig = new URL('../tsconfig.base.json', import.meta.url).pathname;
let browser: Browser;
let server: Awaited<ReturnType<typeof start>>;
let dir: string;
let catalogId: string;

beforeAll(async () => {
  browser = await launch();
  dir = await mkdtemp(join(tmpdir(), 'a2ui-exhaustion-'));
  await build({ out: dir, tsconfig });
  server = await start({ dir });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.url);
  await page.waitForSelector('html[data-ready]');
  catalogId = (await page.evaluate(() =>
    document.querySelector('#assistant')!.getAttribute('catalog-ids'),
  ))!;
  await context.close();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A heartbeat every 5 ms: the longest gap between beats is the longest the page was frozen. */
const INIT = `
  window.__hb = { last: performance.now(), max: 0 };
  setInterval(() => { const n = performance.now(); __hb.max = Math.max(__hb.max, n - __hb.last); __hb.last = n; }, 5);
  window.__posts = 0;
  const of = window.fetch;
  window.fetch = function (input, init) { if (init && init.method === 'POST') __posts++; return of.apply(this, arguments); };
  window.__renders = 0;
  document.addEventListener('a2ui:render', () => { window.__renders++; window.__lastRender = performance.now(); });
`;

interface Outcome {
  blockMs: number;
  posts: number;
  crashed: boolean;
  errors: string[];
  page: Page;
  close: () => Promise<void>;
}

type Line = Record<string, unknown>;
const H = 'h';
const create = (extra: Record<string, unknown> = {}): Line => ({
  version: '1.0',
  createSurface: { surfaceId: H, catalogId, ...extra },
});
const update = (components: unknown[], surfaceId = H): Line => ({
  version: '1.0',
  updateComponents: { surfaceId, components },
});
const and = (values: unknown[]) => ({ '@call': 'and', args: { values } });
const ROOT = `[data-a2ui-surface="${H}"] [data-a2ui-id="root"]`;
/** 19 strings of 100,000 characters: 1.9 MB in 20 values. */
const bigStrings = (): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: 19 }, (_, i) => [
      `b${i}`,
      String.fromCharCode(97 + i).repeat(100_000),
    ]),
  );
/** An object of `n` keys. */
const wide = (n: number): Record<string, number> =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`k${i.toString(36)}`, 0]),
  );

/** Every line the parser accepts, and none longer than a line may be: the renderer's problem. */
function withinLimits(
  lines: readonly Line[],
  malformedFrom = Infinity,
): string {
  const body = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  lines.forEach((line, index) => {
    const text = JSON.stringify(line);
    expect(text.length).toBeLessThanOrEqual(A2UI_LIMITS.messageChars);
    if (index < malformedFrom) parseA2uiMessage(JSON.parse(text));
  });
  return body;
}

/** Waits until the element has drawn nothing for `quietMs`, or `capMs` passes. */
async function settle(
  page: Page,
  quietMs = 400,
  capMs = 30_000,
): Promise<void> {
  await page
    .waitForFunction(
      (quiet) => {
        const w = window as unknown as { __lastRender?: number };
        return performance.now() - (w.__lastRender ?? 0) > quiet;
      },
      quietMs,
      { timeout: capMs, polling: 100 },
    )
    .catch(() => undefined);
}

async function stream(
  body: string | { url: string },
  waitFor: string | ((page: Page) => Promise<unknown>),
  timeoutMs = 60_000,
  /** What the agent answers a POST with: JSON Lines. */
  answer: (posted: string) => string = () => '',
): Promise<Outcome> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  let crashed = false;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('crash', () => {
    crashed = true;
  });
  await context.addInitScript(INIT);
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.includes('/agent/stream'))
      return typeof body === 'string'
        ? route.fulfill({
            status: 200,
            contentType: 'application/jsonl; charset=utf-8',
            body,
          })
        : route.continue({ url: body.url });
    if (url.includes('/agent/actions'))
      return route.fulfill({
        status: 200,
        contentType: 'application/jsonl',
        body: answer(route.request().postData() ?? ''),
      });
    if (url.startsWith(server.url)) return route.continue();
    return route.abort();
  });
  await page.goto(server.url);
  const waiting =
    typeof waitFor === 'string'
      ? page.waitForSelector(waitFor, { state: 'attached', timeout: timeoutMs })
      : waitFor(page);
  await Promise.race([
    waiting,
    new Promise((resolve) => page.once('crash', resolve)),
  ]);
  if (!crashed) await settle(page);
  const measured = crashed
    ? { blockMs: Infinity, posts: Infinity }
    : await page.evaluate(() => {
        const w = window as unknown as {
          __hb: { max: number; last: number };
          __posts: number;
        };
        return {
          blockMs: Math.round(
            Math.max(w.__hb.max, performance.now() - w.__hb.last),
          ),
          posts: w.__posts,
        };
      });
  return {
    ...measured,
    crashed,
    errors,
    page,
    close: () => context.close().catch(() => undefined),
  };
}

function responsive(outcome: Outcome, maxPosts = MAX_POSTS): void {
  expect(outcome.crashed).toBe(false);
  expect(outcome.errors).toEqual([]);
  expect(outcome.blockMs).toBeLessThan(BLOCK_MS);
  expect(outcome.posts).toBeLessThanOrEqual(maxPosts);
}

/** 19 TextFields, each labelled with a 99,000-character string from the data model. */
const textFields = (label: (i: number) => string): Line[] => [
  create({
    dataModel: {
      t: Object.fromEntries(
        Array.from({ length: 19 }, (_, i) => [
          `b${i}`,
          label(i).slice(0, 99_000),
        ]),
      ),
    },
  }),
  update([
    {
      id: 'root',
      component: 'Column',
      children: Array.from({ length: 19 }, (_, i) => `f${i}`),
    },
    ...Array.from({ length: 19 }, (_, i) => ({
      id: `f${i}`,
      component: 'TextField',
      label: { '@path': `/t/b${i}` },
    })),
  ]),
];

/** `n` drawings of one component under a Column root. */
const drawn = (id: string, n: number): Line =>
  update([{ id: 'root', component: 'Column', children: Array(n).fill(id) }]);
/** `n` drawings of a template over a list of `n` items. */
const templated = (
  component: Record<string, unknown>,
  n: number,
  data = {},
): Line[] => [
  create({ dataModel: { items: Array(n).fill(0), ...data } }),
  update([
    {
      id: 'root',
      component: 'Column',
      children: { path: '/items', componentId: 't' },
    },
    { id: 't', ...component },
  ]),
];

const CASES: Record<string, () => Line[]> = {
  // Work functions do on what they are given.
  'formatDate with a 256-letter format, 255 calls x 78': () =>
    templated(
      {
        component: 'Text',
        text: and(
          Array(255).fill({
            '@call': 'formatDate',
            args: { value: 0, format: { '@path': '/f' } },
          }),
        ),
      },
      78,
      { f: 'yMdEHhmsa'.repeat(29).slice(0, 256) },
    ),
  'length of a 100,000-char string, 255 calls x 78': () =>
    templated(
      {
        component: 'Text',
        text: and(
          Array(255).fill({
            '@call': 'length',
            args: { value: { '@path': '/s' }, min: 1 },
          }),
        ),
      },
      78,
      { s: 'a'.repeat(100_000) },
    ),
  'email of a 100,000-char near-address, 255 calls x 78': () =>
    templated(
      {
        component: 'Text',
        text: and(
          Array(255).fill({
            '@call': 'email',
            args: { value: { '@path': '/s' } },
          }),
        ),
      },
      78,
      { s: 'a@' + 'b.'.repeat(49_998) + ' ' },
    ),
  'length of a bound 1.9 MB object, 255 calls x 40': () => [
    create({ dataModel: { big: bigStrings() } }),
    update([
      {
        id: 't',
        component: 'Text',
        text: and(
          Array(255).fill({
            '@call': 'length',
            args: { value: { '@path': '/big' }, min: 0 },
          }),
        ),
      },
    ]),
    drawn('t', 40),
  ],
  'email of a bound 1.9 MB object, 255 calls x 78': () => [
    create({ dataModel: { big: bigStrings() } }),
    update([
      {
        id: 't',
        component: 'Text',
        text: and(
          Array(255).fill({
            '@call': 'email',
            args: { value: { '@path': '/big' } },
          }),
        ),
      },
    ]),
    drawn('t', 78),
  ],
  'formatCurrency, 255 calls x 78': () => [
    create(),
    update([
      {
        id: 't',
        component: 'Text',
        text: and(
          Array(255).fill({
            '@call': 'formatCurrency',
            args: { value: 1234.5, currency: 'EUR', decimals: 2 },
          }),
        ),
      },
    ]),
    drawn('t', 78),
  ],
  // Values walked whole.
  'Text bound to a 1.9 MB object x 9,990': () => [
    create({ dataModel: { big: bigStrings() } }),
    update([{ id: 't', component: 'Text', text: { '@path': '/big' } }]),
    drawn('t', 9_990),
  ],
  'Text whose text is the widest literal object a message may carry, x 100':
    () => [
      create(),
      update([{ id: 't', component: 'Text', text: wide(V) }]),
      drawn('t', 100),
    ],
  'Text whose text is the longest literal list a message may carry, x 1,000':
    () => [
      create(),
      update([{ id: 't', component: 'Text', text: Array(V).fill(0) }]),
      drawn('t', 1_000),
    ],
  'Card prop bound to the widest object a message may carry, x 4,995': () => [
    create({ dataModel: { w: wide(V) } }),
    update([
      { id: 'card', component: 'Card', child: 'l', blob: { '@path': '/w' } },
      { id: 'l', component: 'Text', text: 'x' },
    ]),
    drawn('card', 4_995),
  ],
  'Card prop bound to the longest list a message may carry, x 4,990': () => [
    create({ dataModel: { a: Array(V).fill(0) } }),
    update([
      { id: 'card', component: 'Card', child: 'l', blob: { '@path': '/a' } },
      { id: 'l', component: 'Text', text: 'x' },
    ]),
    drawn('card', 4_990),
  ],
  'Card prop bound to a 1.9 MB object x 1,000': () => [
    create({ dataModel: { big: bigStrings() } }),
    update([
      { id: 'card', component: 'Card', child: 'l', blob: { '@path': '/big' } },
      { id: 'l', component: 'Text', text: 'x' },
    ]),
    drawn('card', 1_000),
  ],
  'Card with as many scalar props as a message may carry, x 1,000': () => [
    create(),
    update([
      { id: 'card', component: 'Card', child: 'l', ...wide(V) },
      { id: 'l', component: 'Text', text: 'x' },
    ]),
    drawn('card', 1_000),
  ],
  // Many small things in one component.
  'Button with as many empty checks as a message may carry, x 1,000': () => [
    create(),
    update([
      {
        id: 'b',
        component: 'Button',
        child: 'l',
        action: { event: { name: 'go' } },
        '@checks': Array(V).fill({}),
      },
      { id: 'l', component: 'Text', text: 'go' },
    ]),
    drawn('b', 1_000),
  ],
  'Button with as many failing checks as a message may carry, x 10': () => [
    create(),
    update([
      {
        id: 'b',
        component: 'Button',
        child: 'l',
        action: { event: { name: 'go' } },
        '@checks': Array(Math.floor(V / 3)).fill({
          condition: false,
          message: 'm',
        }),
      },
      { id: 'l', component: 'Text', text: 'go' },
    ]),
    drawn('b', 10),
  ],
  'Button with 19 failing checks of 100,000-char messages x 100': () => [
    create(),
    update([
      {
        id: 'b',
        component: 'Button',
        child: 'l',
        action: { event: { name: 'go' } },
        '@checks': Array(19).fill({
          condition: false,
          message: 'lorem ipsum '.repeat(8_334).slice(0, 100_000),
        }),
      },
      { id: 'l', component: 'Text', text: 'go' },
    ]),
    drawn('b', 100),
  ],
  'Button whose checks each call a distinct unknown function': () => [
    create(),
    update([
      {
        id: 'root',
        component: 'Button',
        child: 'l',
        action: { event: { name: 'go' } },
        '@checks': Array.from({ length: Math.floor(V / 4) }, (_, i) => ({
          condition: { '@call': `f${i}` },
          message: 'm',
        })),
      },
      { id: 'l', component: 'Text', text: 'go' },
    ]),
  ],
  '900 relative paths of 2,047 chars in one Text x 370': () => [
    create(),
    update([
      {
        id: 't',
        component: 'Text',
        text: and(
          Array(900).fill({ '@path': 'a/'.repeat(1024).slice(0, 2047) }),
        ),
      },
    ]),
    drawn('t', 370),
  ],
  'markdown of 20,000 chars of *a* x 100': () =>
    templated({ component: 'Text', text: { '@path': '/md' } }, 100, {
      md: '*a*'.repeat(6_666),
    }),
  // Text priced by its length alone, where laying it out costs far more (the sixth audit).
  'TextFields labelled with 99,000 characters alternating direction, x 19':
    () => textFields((i) => 'a\u05d0'.repeat(49_500).slice(i)),
  'TextFields labelled with bidi words, x 19': () =>
    textFields(() => '\u05e9\u05dc\u05d5\u05dd hello '.repeat(9_000)),
  'TextFields labelled with Arabic and Latin, x 19': () =>
    textFields(() => '\u0645\u0631\u062d\u0628\u0627 abc '.repeat(9_900)),
  'TextFields labelled with Thai, x 19': () =>
    textFields(() =>
      '\u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35\u0e04\u0e23\u0e31\u0e1a'.repeat(
        9_900,
      ),
    ),
  'TextFields labelled with rotating scripts, x 19': () =>
    textFields(() => 'a\u03b1\u0431\u05d0\u4e2d\u0905'.repeat(16_500)),
  // as much as a draw's text budget allows: what it costs is what the budget is for
  'one Text of bidi words just inside the text budget': () => [
    create(),
    update([
      {
        id: 'root',
        component: 'Text',
        text: '\u05e9\u05dc\u05d5\u05dd hello '.repeat(990),
      },
    ]),
  ],
  'one Text alternating direction just inside the text budget': () => [
    create(),
    update([{ id: 'root', component: 'Text', text: 'a\u05d0'.repeat(990) }]),
  ],
  '1,000 Texts of bidi words, together just inside the text budget': () =>
    templated({ component: 'Text', text: { '@path': '/w' } }, 1_000, {
      w: '\u05e9\u05dc\u05d5\u05dd ok '.repeat(1),
    }),
  '1,000 Texts alternating direction, together just inside the text budget':
    () =>
      templated({ component: 'Text', text: { '@path': '/w' } }, 1_000, {
        w: 'a\u05d0'.repeat(1),
      }),
  'a Text of 20,000 characters alternating direction': () => [
    create(),
    update([{ id: 'root', component: 'Text', text: 'a\u05d0'.repeat(10_000) }]),
  ],
  'a long TextField value alternating direction': () => [
    create({ dataModel: { v: 'a\u05d0'.repeat(49_500) } }),
    update([
      {
        id: 'root',
        component: 'TextField',
        label: 'note',
        variant: 'longText',
        value: { '@path': '/v' },
      },
    ]),
  ],
  'a Button labelled with 99,000 characters alternating direction': () => [
    create({ dataModel: { v: 'a\u05d0'.repeat(49_500) } }),
    update([
      {
        id: 'root',
        component: 'Button',
        child: 'l',
        action: { event: { name: 'go' } },
      },
      { id: 'l', component: 'Text', text: { '@path': '/v' } },
    ]),
  ],
  'Fare (a registry view) x 9,990': () => [
    create(),
    update([
      {
        id: 'f',
        component: 'Fare',
        label: 'x',
        amount: { value: 12.5, currency: 'EUR' },
      },
    ]),
    drawn('f', 9_990),
  ],
};

describe('a hostile stream within A2UI_LIMITS leaves the page responsive', () => {
  it.each(Object.keys(CASES))(
    '%s',
    async (name) => {
      const outcome = await stream(withinLimits(CASES[name]!()), ROOT);
      try {
        responsive(outcome);
      } finally {
        await outcome.close();
      }
    },
    120_000,
  );

  it('Tabs of 9,900 tabs under 62 nested Columns with long ids', async () => {
    const sid = 'S'.repeat(512);
    const ids = Array.from({ length: 62 }, (_, i) => `c${i}`.padEnd(128, 'x'));
    const components: unknown[] = ids.map((id, i) => ({
      id: i === 0 ? 'root' : id,
      component: 'Column',
      children: [i + 1 < ids.length ? ids[i + 1] : 'tabs'],
    }));
    components.push(
      {
        id: 'tabs',
        component: 'Tabs',
        tabs: Array.from({ length: 9_900 }, () => ({ title: 't', child: 'x' })),
      },
      { id: 'x', component: 'Text', text: 'x' },
    );
    const outcome = await stream(
      withinLimits([
        { version: '1.0', createSurface: { surfaceId: sid, catalogId } },
        update(components, sid),
      ]),
      `[data-a2ui-surface="${sid}"] [data-a2ui-id="root"]`,
    );
    try {
      responsive(outcome);
    } finally {
      await outcome.close();
    }
  }, 120_000);

  it('the widest data model a message may carry, then 1,000 one-number updates', async () => {
    const N = 1_000;
    const lines = [
      create({ dataModel: wide(V) }),
      update([{ id: 'root', component: 'Text', text: { '@path': '/x' } }]),
      ...Array.from({ length: N }, (_, i) => ({
        version: '1.0',
        updateDataModel: { surfaceId: H, path: '/x', value: i },
      })),
    ];
    const outcome = await stream(withinLimits(lines), (page) =>
      page.waitForFunction(
        ([selector, last]) =>
          document.querySelector(selector)?.textContent === last,
        [ROOT, String(N - 1)] as const,
        { timeout: 60_000 },
      ),
    );
    try {
      responsive(outcome);
      expect(await outcome.page.textContent(ROOT)).toBe(String(N - 1));
    } finally {
      await outcome.close();
    }
  }, 120_000);

  it('20,000 malformed lines: the agent hears a bounded number of errors', async () => {
    const lines = [
      create(),
      update([{ id: 'root', component: 'Text', text: 'x' }]),
      ...Array.from({ length: 20_000 }, () => ({})),
    ];
    const outcome = await stream(withinLimits(lines, 2), ROOT);
    try {
      responsive(outcome);
    } finally {
      await outcome.close();
    }
  }, 120_000);

  it('1,000 refused updates to a sendDataModel surface holding 1.9 MB', async () => {
    const lines = [
      create({ sendDataModel: true, dataModel: { big: bigStrings() } }),
      update([{ id: 'root', component: 'Text', text: 'x' }]),
      ...Array.from({ length: 1_000 }, () => update([])),
    ];
    const outcome = await stream(withinLimits(lines, 2), ROOT);
    try {
      responsive(outcome);
    } finally {
      await outcome.close();
    }
  }, 120_000);

  it('typing beside 150 Cards bound to the widest object a message may carry', async () => {
    const outcome = await stream(
      withinLimits([
        create({ dataModel: { w: wide(V), q: '' } }),
        update([
          {
            id: 'card',
            component: 'Card',
            child: 'l',
            blob: { '@path': '/w' },
          },
          { id: 'l', component: 'Text', text: 'x' },
          {
            id: 'tf',
            component: 'TextField',
            label: 'q',
            value: { '@path': '/q' },
          },
        ]),
        update([
          {
            id: 'root',
            component: 'Column',
            children: ['tf', ...Array(150).fill('card')],
          },
        ]),
      ]),
      ROOT,
    );
    try {
      responsive(outcome);
      const input = outcome.page.locator(
        `[data-a2ui-surface="${H}"] [data-a2ui-id="tf"] input`,
      );
      await input.click();
      for (const ch of 'abcdef') {
        await outcome.page.evaluate(() => {
          const w = window as unknown as {
            __hb: { max: number; last: number };
          };
          w.__hb.max = 0;
          w.__hb.last = performance.now();
        });
        await outcome.page.keyboard.type(ch);
        await settle(outcome.page, 200, 5_000);
        const block = await outcome.page.evaluate(
          () => (window as unknown as { __hb: { max: number } }).__hb.max,
        );
        expect(block).toBeLessThan(BLOCK_MS);
      }
      expect(await input.inputValue()).toBe('abcdef');
    } finally {
      await outcome.close();
    }
  }, 120_000);
});

describe('an agent cannot make the renderer talk without end', () => {
  const call = (i: number) =>
    JSON.stringify({
      version: '1.0',
      callRendererFunction: {
        functionCallId: `c${i}`,
        callFunction: {
          '@call': 'formatString',
          catalogId,
          args: { value: 'x' },
        },
      },
    });

  it('20,000 renderer function calls are a bounded number of answers', async () => {
    const body =
      [create(), update([{ id: 'root', component: 'Text', text: 'x' }])]
        .map((line) => JSON.stringify(line))
        .join('\n') +
      '\n' +
      Array.from({ length: 20_000 }, (_, i) => call(i)).join('\n') +
      '\n';
    const outcome = await stream(body, ROOT);
    try {
      responsive(outcome);
    } finally {
      await outcome.close();
    }
  }, 120_000);

  it('an agent whose every answer asks for two more calls is held to a rate', async () => {
    let n = 0;
    const body =
      [create(), update([{ id: 'root', component: 'Text', text: 'x' }])]
        .map((line) => JSON.stringify(line))
        .join('\n') +
      '\n' +
      call(n++) +
      '\n';
    const outcome = await stream(
      body,
      ROOT,
      60_000,
      () => `${call(n++)}\n${call(n++)}\n`,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const posts = await outcome.page.evaluate(
        () => (window as unknown as { __posts: number }).__posts,
      );
      // the burst, five a second after it, and the errors refusing the rest
      expect(posts).toBeLessThan(120);
      expect(outcome.crashed).toBe(false);
      expect(outcome.errors).toEqual([]);
    } finally {
      await outcome.close();
    }
  }, 120_000);

  it('errors on a sendDataModel surface holding 1.78 M characters do not write it out', async () => {
    const lines: Line[] = [
      create({ sendDataModel: true }),
      update([
        { id: 'root', component: 'Column', children: ['t'] },
        { id: 't', component: 'Text', text: 'x' },
      ]),
      ...Array.from({ length: 6 }, (_, i) => ({
        version: '1.0',
        updateDataModel: {
          surfaceId: H,
          path: `/d${i}`,
          value: Array.from({ length: 3 }, () => '\u0001'.repeat(99_000)),
        },
      })),
      update(
        Array.from({ length: 10 }, (_, i) => ({
          id: `u${i}`,
          component: `Unknown${i}`,
        })).concat([
          {
            id: 'root',
            component: 'Column',
            children: Array.from({ length: 10 }, (_, i) => `u${i}`),
          } as never,
        ]),
      ),
    ];
    const outcome = await stream(withinLimits(lines), ROOT);
    try {
      responsive(outcome);
    } finally {
      await outcome.close();
    }
  }, 120_000);
});

describe('a stream cannot make a page hold more than the limits', () => {
  it('3,000 updates of 1.9 MB each, at new paths: refused past the limit, the stream closed', async () => {
    const COUNT = 3_000;
    let sent = 0;
    let closed = false;
    const line = (i: number) =>
      JSON.stringify({
        version: '1.0',
        updateDataModel: {
          surfaceId: H,
          path: `/d${i}`,
          value: Object.fromEntries(
            Array.from({ length: 19 }, (_, j) => [
              `s${j}`,
              (String(i).padStart(6, '0') + String.fromCharCode(97 + j))
                .repeat(14_286)
                .slice(0, 100_000),
            ]),
          ),
        },
      });
    const agent = createServer(async (_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/jsonl; charset=utf-8',
      });
      response.on('close', () => {
        closed = true;
      });
      response.write(JSON.stringify(create()) + '\n');
      response.write(
        JSON.stringify(update([{ id: 'root', component: 'Text', text: 'x' }])) +
          '\n',
      );
      for (let i = 0; i < COUNT && !response.destroyed; i++) {
        sent = i + 1;
        if (!response.write(line(i) + '\n'))
          await new Promise((resolve) => response.once('drain', resolve));
      }
      response.end();
    });
    await new Promise<void>((resolve) => agent.listen(0, '127.0.0.1', resolve));
    const port = (agent.address() as AddressInfo).port;
    const outcome = await stream(
      { url: `http://127.0.0.1:${port}/stream` },
      ROOT,
    );
    try {
      // until the agent finishes, or the renderer hangs up on it
      for (
        let t = 0;
        t < 120 && !outcome.crashed && sent < COUNT && !closed;
        t++
      )
        await new Promise((resolve) => setTimeout(resolve, 500));
      await settle(outcome.page);
      expect(outcome.crashed).toBe(false);
      const heap = await outcome.page.evaluate(
        () =>
          (performance as unknown as { memory?: { usedJSHeapSize: number } })
            .memory?.usedJSHeapSize ?? 0,
      );
      expect(heap).toBeLessThan(400e6);
      const blockMs = await outcome.page.evaluate(() => {
        const w = window as unknown as { __hb: { max: number; last: number } };
        return Math.max(w.__hb.max, performance.now() - w.__hb.last);
      });
      expect(blockMs).toBeLessThan(BLOCK_MS);
      expect(sent).toBeLessThan(COUNT); // hung up on, not read to the end
    } finally {
      await outcome.close();
      agent.close();
    }
  }, 180_000);
});
