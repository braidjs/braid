import {
  parseCatalog,
  parseClientManifest,
  parseScreen,
} from '@braidlabs/sdui';
import {
  a2uiCatalogId,
  createA2uiProjector,
  parseA2uiStream,
  prerenderA2ui,
  resolveRendererCapabilities,
  selectPrerendered,
  toJsonLines,
} from '@braidlabs/sdui/a2ui';
import { renderA2uiHtml } from '@braidlabs/sdui/web';
import rawCatalog from '../content/catalog.json';
import rawCurrent from '../content/manifests/web-current.json';
import rawLegacy from '../content/manifests/web-legacy.json';
import rawTrip from '../content/screens/trip.json';
import rebook from '../content/agent/rebook.jsonl';
import { registry } from './registry.js';

/**
 * Everything the Concierge server does with Braid, in one module the build bundles for Node:
 * prerendering the CMS-authored trip screen for every web renderer it serves, and standing between
 * the (stub) agent and each renderer, so each one receives the agent's surface at its own versions.
 */

export const catalog = parseCatalog(rawCatalog);
export const manifests = {
  current: parseClientManifest(rawCurrent),
  legacy: parseClientManifest(rawLegacy),
};
export const catalogIds = {
  current: a2uiCatalogId(catalog, manifests.current),
  legacy: a2uiCatalogId(catalog, manifests.legacy),
};
const registryOf = { catalogs: [catalog], manifests: Object.values(manifests) };
const page = { locale: 'en-US', timeZone: 'UTC' };

/** Prerendered files, path → content: every variant of the trip screen, and `index.json`. */
export function prerender() {
  return prerenderA2ui({
    catalog,
    screens: [parseScreen(rawTrip)],
    manifests: Object.values(manifests),
    contexts: [
      { name: '', context: {} },
      { name: 'summer-sale', context: { flags: { 'summer-sale': true } } },
    ],
    html: (messages) => {
      const ids = messages.flatMap((m) =>
        m.createSurface?.catalogId ? [m.createSurface.catalogId] : [],
      );
      return renderA2uiHtml(messages, {
        registry,
        catalog,
        catalogIds: ids,
        ...page,
      }).html;
    },
  }).files;
}

/** Which renderer a request is from: a capabilities header, or `?renderer=legacy`, or the current one. */
export function rendererOf(capabilitiesHeader, query) {
  if (capabilitiesHeader) {
    try {
      return resolveRendererCapabilities(
        JSON.parse(capabilitiesHeader),
        registryOf,
      );
    } catch {
      return { status: 'manifest-unknown', supportedCatalogIds: [] };
    }
  }
  const name = query === 'legacy' ? 'legacy' : 'current';
  return {
    status: 'ok',
    catalog,
    manifest: manifests[name],
    catalogId: catalogIds[name],
  };
}

export { selectPrerendered };

/** The agent's opening stream, as this renderer should receive it. */
export function agentStream(renderer) {
  const projector = createA2uiProjector({
    catalog,
    manifest: renderer.manifest,
    catalogId: renderer.catalogId,
  });
  const out = [];
  for (const message of parseA2uiStream(rebook)) {
    const { toRenderer, toAgent } = projector.push(message);
    out.push(...toRenderer);
    for (const told of toAgent)
      console.warn('agent told:', JSON.stringify(told));
  }
  return toJsonLines(out);
}

/** The stub agent's answer to what a renderer sends back: more messages, as JSON Lines. */
export function answer(envelope) {
  const action = envelope?.message?.action;
  if (!action) return '';
  if (action.name === 'book') {
    const email = action.context?.email;
    return toJsonLines([
      {
        version: '1.0',
        updateDataModel: {
          surfaceId: action.surfaceId,
          path: '/status',
          value: `Rebooked on ${action.context?.flight}. Your boarding pass is on its way to ${email}.`,
        },
      },
    ]);
  }
  if (action.name === 'selectFlight')
    return toJsonLines([
      {
        version: '1.0',
        updateDataModel: {
          surfaceId: action.surfaceId,
          path: '/flight',
          value: action.context?.flight,
        },
      },
    ]);
  return '';
}

export { renderA2uiHtml, registry };
