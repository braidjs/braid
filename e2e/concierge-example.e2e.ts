import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launch } from './harness.js';
// the example itself, as it is built and served: what its README says is what this runs
import { build } from '../examples/concierge/build.mjs';
import { start } from '../examples/concierge/server.mjs';
import { parseCatalog, parseClientManifest } from '../libs/sdui/src/index.js';
import { A2UI_BASIC_CATALOG_ID, a2uiCatalogId } from '../libs/sdui/src/a2ui.js';

/**
 * The Concierge example (`examples/concierge`) in Chromium: A2UI surfaces drawn into a host app's
 * own page. A CMS-authored screen arrives prerendered for the renderer asking and is taken over;
 * an agent's surface arrives through the projector; two component types are the host's own — its
 * custom element, and another team's Braid fragment. The upstream A2UI gallery is drawn in the
 * host's styles, and hostile content is drawn inert.
 */

const tsconfig = new URL('../tsconfig.base.json', import.meta.url).pathname;
const upstream = new URL(
  '../libs/sdui/conformance/a2ui/upstream/examples/',
  import.meta.url,
).pathname;
const content = new URL('../examples/concierge/content/', import.meta.url)
  .pathname;

let browser: Browser;
let server: Awaited<ReturnType<typeof start>>;
let dir: string;
let ids: { current: string; legacy: string };

beforeAll(async () => {
  browser = await launch();
  dir = await mkdtemp(join(tmpdir(), 'concierge-e2e-'));
  await build({ out: dir, tsconfig });
  server = await start({ dir });
  const json = async (path: string) =>
    JSON.parse(await readFile(join(content, path), 'utf8'));
  const catalog = parseCatalog(await json('catalog.json'));
  ids = {
    current: a2uiCatalogId(
      catalog,
      parseClientManifest(await json('manifests/web-current.json')),
    ),
    legacy: a2uiCatalogId(
      catalog,
      parseClientManifest(await json('manifests/web-legacy.json')),
    ),
  };
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

interface Opened {
  page: Page;
  errors: string[];
}

/** A fresh profile; page errors are collected, not just logged. */
async function open(
  path = '',
  options: { javaScriptEnabled?: boolean } = {},
): Promise<Opened> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
    ...options,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.url + path);
  if (options.javaScriptEnabled !== false)
    await page.waitForSelector('html[data-ready]');
  return { page, errors };
}

/** What the surfaces on the page have sent: `a2ui:message` details, recorded by the app. */
const sent = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __a2uiSent?: unknown[] }).__a2uiSent ?? [],
  );
const received = (name: string) =>
  server.received.filter((entry) => entry.message?.['action']?.name === name);

async function until<T>(
  read: () => T | Promise<T>,
  ok: (value: T) => boolean,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline)
      throw new Error(
        `timed out waiting for ${what}: ${JSON.stringify(value)?.slice(0, 400)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('the upstream A2UI gallery, in the host’s own page', () => {
  it('draws every example with no page error and no A2UI error, styled by the host', async () => {
    const files = (await readdir(upstream))
      .filter((file) => file.endsWith('.json'))
      .sort();
    expect(files.length).toBeGreaterThanOrEqual(40);
    const { page, errors } = await open('gallery.html');
    for (const file of files) {
      const { messages } = JSON.parse(
        await readFile(join(upstream, file), 'utf8'),
      );
      await page.evaluate(
        ({ id, messages, catalog }) => {
          const element = document.createElement(
            'a2ui-surface',
          ) as HTMLElement & { push(m: unknown[]): void };
          element.id = id;
          element.setAttribute('catalog-ids', catalog);
          element.setAttribute('locale', 'en-US');
          element.setAttribute('time-zone', 'UTC');
          document.querySelector('#gallery')!.append(element);
          element.push(messages);
        },
        {
          id: file.replace('.json', ''),
          messages,
          catalog: A2UI_BASIC_CATALOG_ID,
        },
      );
    }
    await page.waitForFunction(
      (n) =>
        document.querySelectorAll('a2ui-surface [data-a2ui-id="root"]')
          .length >= n,
      files.length,
    );
    expect(errors).toEqual([]);
    expect(await sent(page)).toEqual([]);
    expect(
      await page
        .locator('#gallery [data-a2ui-pending], #gallery [data-a2ui-unknown]')
        .count(),
    ).toBe(0);
    for (const file of files)
      expect(
        await page
          .locator(`#${file.replace('.json', '')} [data-a2ui-id="root"]`)
          .count(),
      ).toBe(1);

    // the host's rule for `button` is what an A2UI Button looks like: it is in the host's DOM
    const button = page.locator('#product-card .a2ui-Button').first();
    const look = await button.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        background: style.backgroundColor,
        radius: style.borderTopLeftRadius,
        inDocument: el.getRootNode() === document,
      };
    });
    expect(look).toEqual({
      background: 'rgb(15, 118, 110)',
      radius: '999px',
      inDocument: true,
    });

    // and the host's own panel draws the agent's Card, with the card's content in it
    const card = page.locator('#product-card concierge-card').first();
    expect(await card.count()).toBe(1);
    const slotted = card.locator('> [slot="child"]');
    expect(await slotted.count()).toBe(1);
    expect((await slotted.boundingBox())!.height).toBeGreaterThan(50);
    expect(
      await card.evaluate(
        (el) => el.shadowRoot!.querySelector('.mark')!.textContent,
      ),
    ).toBe('Concierge');
    await page.context().close();
  });

  it('draws hostile content inert: no script runs, nothing outside the allowlist, blocked URLs said so', async () => {
    const { page, errors } = await open('gallery.html');
    const popups: string[] = [];
    page.context().on('page', (popup) => popups.push(popup.url()));
    await page.evaluate((catalog) => {
      const element = document.createElement('a2ui-surface') as HTMLElement & {
        push(m: unknown[]): void;
      };
      element.id = 'hostile';
      element.setAttribute('catalog-ids', catalog);
      document.querySelector('#gallery')!.append(element);
      element.push([
        {
          version: '1.0',
          createSurface: {
            surfaceId: 'x',
            catalogId: catalog,
            dataModel: { evil: '<img src=x onerror="window.__pwned=1">' },
          },
        },
        {
          version: '1.0',
          updateComponents: {
            surfaceId: 'x',
            components: [
              {
                id: 'root',
                component: 'Column',
                children: ['t1', 't2', 't3', 'i1', 'v1', 'b1', 'f1'],
              },
              {
                id: 't1',
                component: 'Text',
                text: '<script>window.__pwned=1</script><b onclick="x()">bold</b><iframe src="javascript:1">',
              },
              { id: 't2', component: 'Text', text: { '@path': '/evil' } },
              {
                id: 't3',
                component: 'Text',
                text: '[click me](javascript:window.__pwned=1)',
              },
              {
                id: 'i1',
                component: 'Image',
                url: 'javascript:window.__pwned=1',
                description: 'a picture',
              },
              {
                id: 'v1',
                component: 'Video',
                url: 'data:text/html,<script>window.__pwned=1</script>',
              },
              {
                id: 'b1',
                component: 'Button',
                child: 'bl',
                action: {
                  functionCall: {
                    '@call': 'openUrl',
                    args: { url: 'java\tscript:window.__pwned=1' },
                  },
                },
              },
              { id: 'bl', component: 'Text', text: 'Open' },
              {
                id: 'f1',
                component: 'TextField',
                label: 'Phone',
                value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!',
                '@checks': [
                  {
                    condition: {
                      '@call': 'regex',
                      args: {
                        value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!',
                        pattern: '(a+)+$',
                      },
                    },
                    message: 'x',
                  },
                ],
              },
            ],
          },
        },
      ]);
    }, A2UI_BASIC_CATALOG_ID);
    const surface = page.locator('#hostile');
    await surface.locator('[data-a2ui-id="root"]').waitFor();
    await surface.locator('button').click();
    await page.waitForTimeout(200);

    expect(errors).toEqual([]);
    expect(popups).toEqual([]);
    expect(
      await page.evaluate(
        () => (window as unknown as { __pwned?: number }).__pwned,
      ),
    ).toBeUndefined();
    expect(
      await surface
        .locator('script, iframe, object, embed, style, img, link')
        .count(),
    ).toBe(0);
    const handlers = await surface.evaluate((root) =>
      [...root.querySelectorAll('*')].flatMap((el) =>
        el.getAttributeNames().filter((name) => name.startsWith('on')),
      ),
    );
    expect(handlers).toEqual([]);
    expect(
      await surface.locator('[data-a2ui-state="blocked-url"]').count(),
    ).toBe(3);
    expect(
      await surface.locator('[data-a2ui-id="t1"]').textContent(),
    ).toContain('<script>');
    const reported = (await sent(page)) as {
      error?: { code: string; message: string };
    }[];
    expect(reported.map((m) => m.error?.code)).toEqual([
      'EXPRESSION_ERROR',
      'EXPRESSION_ERROR',
    ]);
    expect(reported.map((m) => m.error?.message).join(' ')).toMatch(
      /backtrack[\s\S]*blocked-url|blocked-url[\s\S]*backtrack/,
    );
    await page.context().close();
  });
});

describe('a Braid fragment as an agent’s component', () => {
  it('mounts the flights team’s fragment in place, and its event reaches the agent as one A2UI action', async () => {
    const { page, errors } = await open();
    const slot = page.locator(
      '#assistant fragment-slot[data-a2ui-id="flight"]',
    );
    await page.waitForSelector(
      '#assistant fragment-slot[data-a2ui-id="flight"]:is([state="ready"], [state="healthy"])',
    );
    expect(await slot.locator('.flight').getAttribute('data-flight')).toBe(
      'TP 1351',
    );
    // in the host's layout, between the agent's other components
    const order = await page
      .locator('#assistant [data-a2ui-id]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-a2ui-id')));
    expect(order.indexOf('flight')).toBe(order.indexOf('intro') + 1);

    const before = received('selectFlight').length;
    await slot.locator('button').click();
    const actions = await until(
      () => received('selectFlight'),
      (list) => list.length > before,
      'the selectFlight action',
    );
    await page.waitForTimeout(200);
    expect(received('selectFlight')).toHaveLength(before + 1);
    expect(actions.at(-1)!.message).toMatchObject({
      version: '1.0',
      action: {
        name: 'selectFlight',
        surfaceId: 'assistant',
        sourceComponentId: 'flight',
        context: {
          flight: 'TP 1351',
          detail: { flight: 'TP 1351', at: 'flight-card' },
        },
      },
    });
    // the renderer sent the data model along, as the surface asked (sendDataModel)
    expect(actions.at(-1)!.metadata).toMatchObject({
      a2uiRendererDataModel: { assistant: { flight: 'TP 1351' } },
    });
    expect(errors).toEqual([]);
    await page.context().close();
  });
});

describe('two-way binding', () => {
  it('typing updates what is bound to the same path; an agent update keeps focus and caret; checks gate the button', async () => {
    const { page, errors } = await open();
    const name = page.locator('#assistant [data-a2ui-id="name"] input');
    await name.waitFor();
    await name.fill('Grace Hopper');
    await expect
      .poll(() =>
        page.locator('#assistant [data-a2ui-id="summary"]').textContent(),
      )
      .toBe('Rebooking Grace Hopper on TP 1351');

    // mark the element, put the caret mid-word, and have the agent change the value under it
    await name.evaluate((input: HTMLInputElement) => {
      (input as unknown as { marked: boolean }).marked = true;
      input.focus();
      input.setSelectionRange(5, 5);
    });
    await page.evaluate(() =>
      (
        document.querySelector('#assistant') as HTMLElement & {
          push(m: unknown[]): void;
        }
      ).push([
        {
          version: '1.0',
          updateDataModel: {
            surfaceId: 'assistant',
            path: '/passenger/name',
            value: 'Grace B. Hopper',
          },
        },
      ]),
    );
    await expect
      .poll(() =>
        page.locator('#assistant [data-a2ui-id="summary"]').textContent(),
      )
      .toBe('Rebooking Grace B. Hopper on TP 1351');
    const after = await page.evaluate(() => {
      const input = document.querySelector(
        '#assistant [data-a2ui-id="name"] input',
      ) as HTMLInputElement;
      return {
        same: (input as unknown as { marked?: boolean }).marked === true,
        focused: document.activeElement === input,
        value: input.value,
        caret: [input.selectionStart, input.selectionEnd],
      };
    });
    expect(after).toEqual({
      same: true,
      focused: true,
      value: 'Grace B. Hopper',
      caret: [5, 5],
    });

    const book = page.locator('#assistant [data-a2ui-id="book"] button');
    expect(await book.isDisabled()).toBe(true);
    expect(
      await page.locator('#assistant [data-a2ui-id="book"]').textContent(),
    ).toContain('Add an email first.');
    const before = received('book').length;
    await page
      .locator('#assistant [data-a2ui-id="email"] input')
      .fill('grace@example.com');
    await expect.poll(() => book.isDisabled()).toBe(false);
    await book.click();
    await until(
      () => received('book'),
      (list) => list.length > before,
      'the book action',
    );
    await page.waitForTimeout(200);
    expect(received('book')).toHaveLength(before + 1);
    expect(received('book').at(-1)!.message['action'].context).toEqual({
      flight: 'TP 1351',
      email: 'grace@example.com',
    });
    // the agent's answer comes back into the surface
    await expect
      .poll(() =>
        page.locator('#assistant [data-a2ui-id="status"]').textContent(),
      )
      .toMatch(/^Rebooked on TP 1351/);
    expect(errors).toEqual([]);
    await page.context().close();
  });
});

describe('prerendered variants', () => {
  it('shows the trip with JavaScript off', async () => {
    const { page } = await open('', { javaScriptEnabled: false });
    const trip = page.locator('.trip a2ui-surface');
    expect(await trip.getAttribute('data-prerendered')).toBe('');
    const text = await trip.innerText();
    expect(text).toContain('Lisbon, 3 nights');
    expect(text).toContain('€420.00');
    expect(text).toContain('Book this trip');
    expect(await page.locator('.trip h1').textContent()).toBe(
      'Lisbon, 3 nights',
    );
    await page.context().close();
  });

  it('with JavaScript, the renderer takes it over with the same text and no error', async () => {
    const off = await open('', { javaScriptEnabled: false });
    const prerendered = await off.page
      .locator('.trip a2ui-surface')
      .innerText();
    await off.page.context().close();

    const { page, errors } = await open();
    const trip = page.locator('.trip a2ui-surface');
    // taken over: the messages it carried have been read, and the fragment it names has booted
    await page.waitForFunction(
      () => !document.querySelector('.trip a2ui-surface script'),
    );
    await page.waitForSelector(
      '.trip fragment-slot:is([state="ready"], [state="healthy"])',
    );
    expect(await trip.innerText()).toBe(prerendered);
    expect(
      ((await sent(page)) as { error?: unknown }[]).filter((m) => m.error),
    ).toEqual([]);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('serves each renderer its own variant: an old build gets the downgraded one', async () => {
    const as = async (catalogId: string) => {
      const response = await fetch(server.url, {
        headers: {
          'A2UI-Renderer-Capabilities': JSON.stringify({
            '1.0': { supportedCatalogIds: [catalogId] },
          }),
        },
      });
      expect(response.status).toBe(200);
      return response.text();
    };
    const current = await as(ids.current);
    const legacy = await as(ids.legacy);
    expect(current).toContain(
      `catalog-ids="${ids.current.replace(/&/g, '&#38;')}"`,
    );
    expect(legacy).toContain(
      `catalog-ids="${ids.legacy.replace(/&/g, '&#38;')}"`,
    );
    // the current build gets the fare and the flights team's card
    expect(current).toContain('€420.00');
    expect(current).toContain('<fragment-slot');
    // build 1.9 has neither Fare v3 nor FlightCard: their stand-ins, never a guessed value
    expect(legacy).not.toContain('€420.00');
    expect(legacy).not.toContain('EUR');
    expect(legacy).not.toContain('<fragment-slot');
    expect(legacy).toContain('Return flight');
    expect(legacy).toContain('TP 1351');
    const unknown = await fetch(server.url, {
      headers: {
        'A2UI-Renderer-Capabilities': JSON.stringify({
          '1.0': {
            supportedCatalogIds: ['https://other.example/catalog.json'],
          },
        }),
      },
    });
    expect(unknown.status).toBe(409);

    // and in a browser, the old build's page and its agent surface draw without error
    const { page, errors } = await open('?renderer=legacy');
    await page.locator('#assistant [data-a2ui-id="root"]').waitFor();
    expect(await page.locator('#assistant fragment-slot').count()).toBe(0);
    expect(
      await page.locator('#assistant [data-a2ui-id="flight"]').textContent(),
    ).toBe('TP 1351');
    expect(
      ((await sent(page)) as { error?: unknown }[]).filter((m) => m.error),
    ).toEqual([]);
    expect(errors).toEqual([]);
    await page.context().close();
  });
});
