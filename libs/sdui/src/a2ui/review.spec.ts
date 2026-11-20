import { describe, expect, it } from 'vitest';
import type { SduiCatalog } from '../lib/catalog.js';
import { createClientManifest } from '../lib/manifest.js';
import { migrate } from '../lib/migrate.js';
import { a2uiBasicCatalog, A2UI_BASIC_CATALOG_ID } from './basic.js';
import { surfaceMessages, surfaceToScreen } from './codec.js';
import { parseA2uiMessage } from './messages.js';
import { createA2uiProjector } from './projector.js';
import { A2uiSurfaces } from './surfaces.js';

/** Regressions for what the code review of the A2UI core found, each from the input that showed it. */

const B = A2UI_BASIC_CATALOG_ID;
function surface(components: unknown[], dataModel?: object) {
  const surfaces = new A2uiSurfaces();
  surfaces.apply(
    parseA2uiMessage({
      version: '1.0',
      createSurface: {
        surfaceId: 's',
        catalogId: B,
        ...(dataModel ? { dataModel } : {}),
      },
    }),
  );
  surfaces.apply(
    parseA2uiMessage({
      version: '1.0',
      updateComponents: { surfaceId: 's', components },
    }),
  );
  return surfaces.get('s')!;
}

describe('a tab whose content is dropped takes its tab with it', () => {
  it('pairs titles with their own content after projection omits one', () => {
    // a renderer with no Text: Text's fallback is to omit
    const noText = createClientManifest(a2uiBasicCatalog, {
      app: 'a',
      platform: 'web',
      version: '1.0.0',
      pin: { Text: 0 },
    });
    const projector = createA2uiProjector({
      catalog: a2uiBasicCatalog,
      manifest: noText,
    });
    projector.push({
      version: '1.0',
      createSurface: { surfaceId: 's', catalogId: B },
    });
    const out = projector.push({
      version: '1.0',
      updateComponents: {
        surfaceId: 's',
        components: [
          {
            id: 'root',
            component: 'Tabs',
            tabs: [
              { title: 'A', child: 'a' },
              { title: 'B', child: 'b' },
              { title: 'C', child: 'c' },
            ],
          },
          { id: 'a', component: 'Divider' },
          { id: 'b', component: 'Text', text: 'gone' },
          { id: 'c', component: 'Card', child: 'cc' },
          { id: 'cc', component: 'Divider' },
        ],
      },
    });
    const created = out.toRenderer.flatMap((m) =>
      'updateComponents' in m
        ? m.updateComponents.components
        : 'createSurface' in m
          ? (m.createSurface.components ?? [])
          : [],
    );
    const tabs = created.find((c) => c.id === 'root')!['tabs'];
    expect(tabs).toEqual([
      { title: 'A', child: 'a' },
      { title: 'C', child: 'c' },
    ]);
    expect(JSON.stringify(created)).not.toMatch(/~tabs~/);
  });
});

describe('ids made for copies never collide with ids an agent sent', () => {
  it('a shared component next to one already named like its copy', () => {
    const state = surface([
      { id: 'root', component: 'Column', children: ['t', 'u', 't~1', 't~0'] },
      { id: 't', component: 'Text', text: 'shared' },
      { id: 'u', component: 'Card', child: 't' },
      { id: 't~1', component: 'Text', text: 'mine' },
      { id: 't~0', component: 'Text', text: 'also mine' },
    ]);
    const { screen } = surfaceToScreen(state, { catalog: a2uiBasicCatalog });
    const [created] = surfaceMessages({
      surfaceId: 's',
      catalogId: B,
      root: screen!.root,
      catalog: a2uiBasicCatalog,
    });
    const components = (
      created as { createSurface: { components: { id: string }[] } }
    ).createSurface.components;
    expect(Object.fromEntries(components.map((c) => [c.id, c]))).toEqual(
      Object.fromEntries(state.components),
    );
  });
});

describe('a binding is checked against each op as the ops before it left the value', () => {
  const contract = {
    skewContract: '1' as const,
    name: 'sdui.component.Title',
    current: 2,
    steps: [
      {
        from: 1,
        to: 2,
        description: 'title becomes a string label',
        ops: [
          { rename: { from: 'title', to: 'label' } },
          { convert: { path: 'label', to: 'string' as const } },
        ],
      },
    ],
  };
  it('a rename then a convert of a bound value is a gap, not "[object Object]"', () => {
    const result = migrate(contract, { title: { '@path': '/n' } }, 1, 2);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(
      /converts "label", which is bound to data/,
    );
  });
  it('the same step over a literal still runs', () => {
    expect(migrate(contract, { title: 7 }, 1, 2)).toMatchObject({
      ok: true,
      value: { label: '7' },
    });
  });
  it('a $from that reads inside a binding is a gap', () => {
    const reading = {
      skewContract: '1' as const,
      name: 'sdui.component.Fare',
      current: 2,
      steps: [
        {
          from: 1,
          to: 2,
          description: 'copies the currency out',
          ops: [
            { default: { path: 'code', value: { $from: 'price.currency' } } },
          ],
        },
      ],
    };
    const result = migrate(reading, { price: { '@path': '/price' } }, 1, 2);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(
      /reaches into "price"/,
    );
  });
});

describe('a renderer is never shown the agent’s catalog id', () => {
  it('rewrites the catalogId of calls inside props and checks', () => {
    const catalog: SduiCatalog = {
      ...a2uiBasicCatalog,
      a2ui: { catalogId: 'https://acme.example/catalog.json' },
    };
    const manifest = createClientManifest(catalog, {
      app: 'a',
      platform: 'web',
      version: '1.0.0',
    });
    const projector = createA2uiProjector({ catalog, manifest });
    projector.push({
      version: '1.0',
      createSurface: {
        surfaceId: 's',
        catalogId: 'https://acme.example/catalog.json',
      },
    });
    const out = projector.push({
      version: '1.0',
      updateComponents: {
        surfaceId: 's',
        components: [
          {
            id: 'root',
            component: 'TextField',
            label: {
              '@call': 'formatString',
              catalogId: 'https://acme.example/catalog.json',
              args: { value: 'Email' },
            },
            value: { '@path': '/e' },
            '@checks': [
              {
                condition: {
                  '@call': 'email',
                  catalogId: 'https://acme.example/catalog.json',
                  args: { value: { '@path': '/e' } },
                },
              },
            ],
          },
        ],
      },
    });
    const text = JSON.stringify(out.toRenderer);
    expect(text).not.toContain(
      '"catalogId":"https://acme.example/catalog.json"',
    );
    expect(text).toContain('caps=cv_');
  });
});
