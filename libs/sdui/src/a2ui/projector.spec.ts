import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCatalog } from '../lib/catalog.js';
import {
  type ClientManifest,
  manifestFingerprint,
  parseClientManifest,
} from '../lib/manifest.js';
import { A2UI_BASIC_CATALOG_ID, a2uiBasicManifest } from './basic.js';
import {
  a2uiAuthoringId,
  a2uiCatalogFor,
  a2uiCatalogId,
  resolveRendererCapabilities,
} from './capabilities.js';
import type { A2uiMessage } from './messages.js';
import { createA2uiProjector, INCOMPATIBLE } from './projector.js';
import { A2uiSurfaces } from './surfaces.js';
import { upstreamValidators } from './upstream.spec-util.js';

const dir = join(import.meta.dirname, '../../conformance/a2ui');
const json = (path: string) =>
  JSON.parse(readFileSync(join(dir, path), 'utf8'));
const catalog = parseCatalog(json('concierge.catalog.json'));
const manifests = {
  current: parseClientManifest(json('manifests/current.json')),
  oneBehind: parseClientManifest(json('manifests/one-behind.json')),
  legacy: parseClientManifest(json('manifests/legacy.json')),
};
const authoring = a2uiAuthoringId(catalog);

/** What an agent sends, authored against the catalog's own id: the newest of everything. */
const agentStream = [
  {
    version: '1.0',
    createSurface: {
      surfaceId: 'trip',
      catalogId: authoring,
      dataModel: { price: { value: 420, currency: 'EUR' }, stars: 4 },
    },
  },
  {
    version: '1.0',
    updateComponents: {
      surfaceId: 'trip',
      components: [
        {
          id: 'root',
          component: 'Column',
          children: ['title', 'fare', 'boundFare', 'rating'],
        },
        { id: 'title', component: 'Text', text: 'Your trip' },
        {
          id: 'fare',
          component: 'Fare',
          label: 'Lisbon',
          amount: { value: 420, currency: 'EUR' },
          badge: 'Best price',
        },
        {
          id: 'boundFare',
          component: 'Fare',
          label: 'Porto',
          amount: { '@path': '/price' },
        },
        { id: 'rating', component: 'Rating', stars: { '@path': '/stars' } },
      ],
    },
  },
];

/** Runs a stream through a projector, and folds what the renderer receives into its own state. */
function through(
  manifest: ClientManifest,
  stream: readonly unknown[] = agentStream,
) {
  const projector = createA2uiProjector({ catalog, manifest });
  const renderer = new A2uiSurfaces();
  const outputs = stream.map((message) => projector.push(message));
  for (const output of outputs)
    for (const message of output.toRenderer) renderer.apply(message);
  const validators = upstreamValidators(a2uiCatalogFor(catalog, manifest));
  for (const output of outputs)
    for (const message of output.toRenderer)
      expect(
        validators.agentToRenderer(message),
        validators.explain(validators.agentToRenderer),
      ).toBe(true);
  const report = (id: string) =>
    outputs
      .flatMap((o) => o.projections)
      .at(-1)
      ?.report.find((entry) => entry.nodeId === id);
  return {
    projector,
    renderer,
    outputs,
    report,
    push: (message: unknown) => projector.push(message),
  };
}

describe('version skew through A2UI', () => {
  it('a renderer built from the newest catalog gets exactly what the agent wrote', () => {
    const { renderer, projector, outputs } = through(manifests.current);
    expect(outputs.at(-1)?.projections[0]?.outcome).toBe('exact');
    const sent = renderer.get('trip')!;
    expect(Object.fromEntries(sent.components)).toEqual(
      Object.fromEntries(projector.surfaces.get('trip')!.components),
    );
    expect(sent.catalogId).toBe(a2uiCatalogId(catalog, manifests.current));
    expect(sent.dataModel).toEqual({
      price: { value: 420, currency: 'EUR' },
      stars: 4,
    });
  });

  it('one version behind: downgraded, with what it loses named', () => {
    const { renderer, report, outputs } = through(manifests.oneBehind);
    expect(outputs.at(-1)?.projections[0]?.outcome).toBe('degraded');
    expect(report('fare')).toMatchObject({
      outcome: 'downgraded',
      rendered: 2,
      lossyPaths: ['badge'],
    });
    const fare = renderer.get('trip')!.components.get('fare')!;
    expect(fare).toEqual({
      id: 'fare',
      component: 'Fare',
      label: 'Lisbon',
      amount: { value: 420, currency: 'EUR' },
    });
    // a binding passes through a step that does not need its value
    expect(renderer.get('trip')!.components.get('boundFare')).toMatchObject({
      amount: { '@path': '/price' },
    });
    expect(report('boundFare')).toMatchObject({
      outcome: 'downgraded',
      lossyPaths: [],
    });
  });

  it('legacy: fallbacks, never a guessed value — and bound values are not reached into', () => {
    const { renderer, report, outputs } = through(manifests.legacy);
    expect(outputs.at(-1)?.projections[0]?.outcome).toBe('fallback');
    const components = renderer.get('trip')!.components;
    // v1 has no currency: losing EUR is losing a critical path, so the catalog's fallback stands in
    expect(report('fare')).toMatchObject({ outcome: 'fallback-catalog' });
    expect(report('fare')!.reason).toMatch(/amount\.currency/);
    // the bound amount would have to be unwrapped, which needs its value
    expect(report('boundFare')).toMatchObject({ outcome: 'fallback-catalog' });
    expect(report('boundFare')!.reason).toMatch(
      /takes a field out of "amount", which is bound to data/,
    );
    // converting a bound number to a string needs its value too; Rating falls back to nothing
    expect(report('rating')).toMatchObject({ outcome: 'omitted' });
    expect(report('rating')!.reason).toMatch(
      /converts "stars", which is bound to data/,
    );
    expect([...components.values()].map((c) => c.component).sort()).toEqual([
      'Column',
      'Text',
      'Text',
      'Text',
    ]);
    expect(
      [...components.values()].some(
        (c) => c.component === 'Fare' || c.component === 'Rating',
      ),
    ).toBe(false);
    // a catalog stand-in keeps the id of the node it stands in for, so actions and analytics do too
    expect(components.get('root')!['children']).toEqual([
      'title',
      'fare',
      'boundFare',
    ]);
    expect(components.get('fare')).toEqual({
      id: 'fare',
      component: 'Text',
      text: 'Lisbon',
    });
    expect(components.get('boundFare')).toEqual({
      id: 'boundFare',
      component: 'Text',
      text: 'Porto',
    });
  });

  it('an update reaches the renderer as the components whose projection changed, and nothing else', () => {
    const current = through(manifests.current);
    const retitled = current.push({
      version: '1.0',
      updateComponents: {
        surfaceId: 'trip',
        components: [
          { id: 'title', component: 'Text', text: 'Your trip to Lisbon' },
        ],
      },
    });
    expect(retitled.toRenderer).toEqual([
      {
        version: '1.0',
        updateComponents: {
          surfaceId: 'trip',
          components: [
            { id: 'title', component: 'Text', text: 'Your trip to Lisbon' },
          ],
        },
      },
    ]);

    // the badge is what one-behind loses anyway: changing it changes nothing that renderer has
    const behind = through(manifests.oneBehind);
    const rebadged = behind.push({
      version: '1.0',
      updateComponents: {
        surfaceId: 'trip',
        components: [
          {
            id: 'fare',
            component: 'Fare',
            label: 'Lisbon',
            amount: { value: 420, currency: 'EUR' },
            badge: 'Last seats',
          },
        ],
      },
    });
    expect(rebadged.toRenderer).toEqual([]);
    expect(
      rebadged.projections[0]?.report.find((e) => e.nodeId === 'fare')
        ?.lossyPaths,
    ).toEqual(['badge']);
  });

  it('data model updates pass through once the renderer has the surface', () => {
    const { push } = through(manifests.legacy);
    const update = {
      version: '1.0',
      updateDataModel: { surfaceId: 'trip', path: '/stars', value: 5 },
    };
    expect(push(update).toRenderer).toEqual([update]);
  });

  it('a surface the renderer cannot show is not sent; the agent is told why', () => {
    const stream = [
      agentStream[0],
      {
        version: '1.0',
        updateComponents: {
          surfaceId: 'trip',
          components: [
            { id: 'root', component: 'Rating', stars: { '@path': '/stars' } },
          ],
        },
      },
    ];
    const { outputs, renderer } = through(manifests.legacy, stream);
    const told = outputs.at(-1)!.toAgent;
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      error: { code: INCOMPATIBLE, surfaceId: 'trip' },
    });
    expect((told[0] as { error: { message: string } }).error.message).toMatch(
      /bound to data/,
    );
    expect(renderer.get('trip')?.components.size ?? 0).toBe(0);
    const validators = upstreamValidators();
    expect(
      validators.rendererToAgent(told[0]),
      validators.explain(validators.rendererToAgent),
    ).toBe(true);
  });

  it('refuses an agent stream authored against a renderer catalog id, telling the agent', () => {
    const projector = createA2uiProjector({
      catalog,
      manifest: manifests.legacy,
    });
    const out = projector.push({
      version: '1.0',
      createSurface: {
        surfaceId: 's',
        catalogId: a2uiCatalogId(catalog, manifests.legacy),
      },
    });
    expect(out.toRenderer).toEqual([]);
    expect(out.toAgent[0]).toMatchObject({
      error: { code: 'VALIDATION_FAILED', path: '/catalogId' },
    });
  });

  it('answers for the renderer when the agent calls a function the renderer lacks', () => {
    const lacking = parseClientManifest({
      ...manifests.current,
      functions: ['required'],
    });
    const projector = createA2uiProjector({ catalog, manifest: lacking });
    const call = (name: string) =>
      projector.push({
        version: '1.0',
        callRendererFunction: {
          functionCallId: `f-${name}`,
          callFunction: { '@call': name, catalogId: authoring, args: {} },
        },
      });
    expect(call('formatDate').toAgent[0]).toMatchObject({
      rendererFunctionResponse: {
        functionCallId: 'f-formatDate',
        error: { code: 'UNKNOWN_FUNCTION' },
      },
    });
    const forwarded = call('required').toRenderer[0] as Extract<
      A2uiMessage,
      { callRendererFunction: unknown }
    >;
    expect(forwarded.callRendererFunction.callFunction.catalogId).toBe(
      a2uiCatalogId(catalog, lacking),
    );
  });
});

describe('catalog ids and renderer capabilities', () => {
  const registry = { catalogs: [catalog], manifests: Object.values(manifests) };
  const { catalogDefinition, capabilities, explain } = upstreamValidators();

  it('gives each manifest a catalog definition of its own, valid by the spec, at its versions', () => {
    for (const manifest of Object.values(manifests)) {
      const definition = a2uiCatalogFor(catalog, manifest);
      expect(catalogDefinition(definition), explain(catalogDefinition)).toBe(
        true,
      );
      expect(definition.catalogId).toBe(
        `${authoring}?manifest=${manifestFingerprint(manifest)}`,
      );
      expect(Object.keys(definition.components).includes('FlightCard')).toBe(
        manifest !== manifests.legacy,
      );
    }
    const legacy = a2uiCatalogFor(catalog, manifests.legacy).components[
      'Fare'
    ] as { properties: Record<string, unknown> };
    expect(Object.keys(legacy.properties)).toEqual([
      'component',
      'label',
      'amount',
    ]);
    const newest = a2uiCatalogFor(catalog);
    expect(catalogDefinition(newest), explain(catalogDefinition)).toBe(true);
    expect(newest.catalogId).toBe(authoring);
    expect(newest.instructions).toMatch(/FlightCard/);
  });

  it("maps a renderer's catalog ids to the manifest it was built with", () => {
    const caps = (ids: string[]) => ({ '1.0': { supportedCatalogIds: ids } });
    for (const manifest of Object.values(manifests)) {
      const id = a2uiCatalogId(catalog, manifest);
      expect(capabilities(caps([id])), explain(capabilities)).toBe(true);
      expect(
        resolveRendererCapabilities(
          caps(['https://other.example/catalog.json', id]),
          registry,
        ),
      ).toMatchObject({
        status: 'ok',
        manifest,
        catalogId: id,
      });
    }
    expect(
      resolveRendererCapabilities(caps([A2UI_BASIC_CATALOG_ID]), registry),
    ).toMatchObject({
      status: 'ok',
      manifest: a2uiBasicManifest,
    });
    expect(
      resolveRendererCapabilities(
        caps(['https://other.example/catalog.json']),
        registry,
      ),
    ).toMatchObject({
      status: 'manifest-unknown',
    });
    // a fingerprint nobody registered is unknown, even under a known catalog
    expect(
      resolveRendererCapabilities(
        caps([`${authoring}?manifest=cm_0000`]),
        registry,
      ).status,
    ).toBe('manifest-unknown');
    expect(
      resolveRendererCapabilities(
        { '0.9': { supportedCatalogIds: [authoring] } },
        registry,
      ),
    ).toMatchObject({
      status: 'protocol-unsupported',
      versions: ['0.9'],
    });
    expect(() =>
      resolveRendererCapabilities(
        { '1.0': { supportedCatalogIds: 'all' } },
        registry,
      ),
    ).toThrow(TypeError);
  });
});
