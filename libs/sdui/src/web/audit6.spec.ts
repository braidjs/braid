// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { A2UI_BASIC_CATALOG_ID } from '../a2ui/basic.js';
import type { A2uiRendererMessage } from '../a2ui/messages.js';
import {
  type A2uiSurfaceElement,
  CALL_LIMITS,
  ERROR_LIMITS,
  defineA2uiSurface,
} from './element.js';
import { renderA2uiHtml } from './html.js';

/** Regressions for what the sixth audit (resource exhaustion, in Chromium) found. */

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
  defineA2uiSurface({ tag: 'audit6-surface' });
});
function mount(): { element: A2uiSurfaceElement; sent: A2uiRendererMessage[] } {
  const element = document.createElement(
    'audit6-surface',
  ) as A2uiSurfaceElement;
  const sent: A2uiRendererMessage[] = [];
  element.addEventListener('a2ui:message', (event) =>
    sent.push((event as CustomEvent).detail),
  );
  document.body.append(element);
  return { element, sent };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('what the sixth audit found', () => {
  it('a label that alternates direction is priced by its runs, not its length', () => {
    const label = 'aא'.repeat(20_000);
    const { errors, html } = renderA2uiHtml([
      create('s'),
      update('s', [{ id: 'root', component: 'TextField', label }]),
    ]);
    expect(errors.map((e) => e.message)).toContain(
      'the surface asks for more text than one draw allows',
    );
    // the page, not the messages it carries for the renderer
    const page = html.replace(
      /<script type="application\/a2ui\+json">[\s\S]*?<\/script>/,
      '',
    );
    expect(page).not.toContain('aאaאaא');
  });

  it('renderer functions an agent asks for are limited in rate, and a flood is hung up on', async () => {
    const { element, sent } = mount();
    const calls = Array.from({ length: 1_000 }, (_, i) =>
      JSON.stringify({
        version: '1.0',
        callRendererFunction: {
          functionCallId: `c${i}`,
          callFunction: {
            '@call': 'formatString',
            catalogId: B,
            args: { value: 'x' },
          },
        },
      }),
    );
    element.push(calls.join('\n'));
    await flush();
    const answers = sent.filter((m) => 'rendererFunctionResponse' in m);
    expect(answers.length).toBe(CALL_LIMITS.burst);
    expect(sent.length).toBeLessThanOrEqual(
      CALL_LIMITS.burst + ERROR_LIMITS.burst + 1,
    );
  });

  it('an error on a sendDataModel surface carries no data model', async () => {
    const bodies: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((_url: string, init?: { body?: string }) => {
      bodies.push(init?.body ?? '');
      return Promise.resolve(new Response(''));
    }) as typeof fetch;
    try {
      const { element } = mount();
      element.setAttribute('action-url', '/actions');
      element.push([
        create('s', {
          sendDataModel: true,
          dataModel: { secret: 'x'.repeat(10_000) },
        }),
        update('s', [{ id: 'root', component: 'Nope' }]),
      ]);
      await flush();
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies)
        expect(body).not.toContain('a2uiRendererDataModel');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('what the sixth verification found', () => {
  it('one push() of many large messages lets the page run between them', async () => {
    const { element } = mount();
    const wide = (n: number) =>
      Object.fromEntries(
        Array.from({ length: 45_000 }, (_, i) => [`k${n}_${i}`, i]),
      );
    const messages = [
      create('s'),
      ...Array.from({ length: 20 }, (_, n) => ({
        version: '1.0',
        updateDataModel: { surfaceId: 's', path: `/d${n}`, value: wide(n) },
      })),
    ];
    const started = performance.now();
    element.push(messages);
    const returned = performance.now() - started;
    // twenty of these, applied at once, would take many times this
    expect(returned).toBeLessThan(250);
    expect(
      Object.keys(element.surfaces.get('s')?.dataModel ?? {}).length,
    ).toBeLessThan(20);
    for (let i = 0; i < 200; i++) {
      if (Object.keys(element.surfaces.get('s')!.dataModel).length === 4) break;
      await flush();
    }
    // the data model's own limit stops it at four of them, in order
    expect(Object.keys(element.surfaces.get('s')!.dataModel)).toEqual([
      'd0',
      'd1',
      'd2',
      'd3',
    ]);
  });

  it('a draw boots only so many fragments', async () => {
    const { DRAW_LIMITS } = await import('./evaluate.js');
    const { html, errors } = renderA2uiHtml(
      [
        create('s'),
        update('s', [
          { id: 'root', component: 'Column', children: Array(200).fill('f') },
          { id: 'f', component: 'Flight' },
        ]),
      ],
      {
        registry: { Flight: { fragment: { name: 'flight', entry: '/f.js' } } },
      },
    );
    expect((html.match(/<fragment-slot/g) ?? []).length).toBe(
      DRAW_LIMITS.fragments,
    );
    expect(errors.map((e) => e.message).join('\n')).toMatch(
      /more than 32 fragments/,
    );
  });

  it('a component named twice in one list is drawn under two keys', () => {
    const { html } = renderA2uiHtml([
      create('s'),
      update('s', [
        { id: 'root', component: 'Column', children: ['t', 't', 't'] },
        { id: 't', component: 'Text', text: 'x' },
      ]),
    ]);
    const keys = [
      ...html.matchAll(
        /data-a2ui-id="t"[^>]*data-a2ui-key="([^"]+)"|data-a2ui-key="([^"]+)"[^>]*data-a2ui-id="t"/g,
      ),
    ].map((m) => m[1] ?? m[2]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  });
});

describe('what the eighth audit found', () => {
  it('video players are weighed as the many draws they cost', () => {
    const { html, errors } = renderA2uiHtml([
      create('s', { dataModel: { u: '/x.mp4' } }),
      update('s', [
        { id: 'root', component: 'Column', children: Array(4_999).fill('v') },
        { id: 'v', component: 'Video', url: { '@path': '/u' } },
      ]),
    ]);
    const players = (html.match(/<video/g) ?? []).length;
    expect(players).toBeGreaterThan(100);
    expect(players).toBeLessThanOrEqual(200);
    expect(errors.map((e) => e.message).join('\n')).toMatch(/draws more than/);
  });
});
