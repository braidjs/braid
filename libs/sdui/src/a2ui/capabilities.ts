import type { ComponentDefinition, SduiCatalog } from '../lib/catalog.js';
import { isRecord, own } from '../lib/internal.js';
import {
  type ClientManifest,
  createClientManifest,
  manifestFingerprint,
} from '../lib/manifest.js';
import {
  A2UI_BASIC_CATALOG_ID,
  a2uiBasicCatalog,
  a2uiBasicManifest,
} from './basic.js';

/**
 * Catalog ids, catalog definitions and renderer capabilities — where an A2UI renderer says what it
 * can draw, and the server learns which client manifest that is.
 *
 * A2UI identifies a catalog by an id and nothing else: a renderer lists the ids it supports, and an
 * agent picks one. An id says nothing about versions, so a renderer that shipped last spring and
 * one that shipped today look the same if they name the same catalog — and then the agent writes
 * for one of them and the other breaks.
 *
 * Here each registered manifest has a catalog id of its own, derived from the catalog's:
 * `https://acme.example/a2ui/catalog.json?manifest=cm_9f2c…`. A renderer built against a manifest
 * names that id; the agent keeps authoring against the plain id, at the newest version of every
 * component; and the server, which knows both, projects each surface to what that renderer was
 * built to draw. The catalog definition each id names is generated from the contracts, at that
 * manifest's versions.
 */

const MANIFEST_PARAM = 'manifest';

/** The id agents author against: the catalog's own, always the newest of everything. */
export function a2uiAuthoringId(catalog: SduiCatalog): string {
  const id = catalog.a2ui?.catalogId;
  if (id === undefined)
    throw new TypeError(
      'sdui a2ui: the catalog has no a2ui.catalogId — give it the id agents author against',
    );
  return id;
}

/**
 * The catalog id for one manifest of a catalog. The basic catalog has one id for everything: it is
 * not versioned within itself.
 */
export function a2uiCatalogId(
  catalog: SduiCatalog,
  manifest?: ClientManifest,
): string {
  const base = a2uiAuthoringId(catalog);
  if (manifest === undefined || base === A2UI_BASIC_CATALOG_ID) return base;
  return `${base}${base.includes('?') ? '&' : '?'}${MANIFEST_PARAM}=${manifestFingerprint(manifest)}`;
}

/** The manifest of a renderer that implements everything a catalog has, at its newest. */
export function a2uiNewestManifest(catalog: SduiCatalog): ClientManifest {
  if (catalog === a2uiBasicCatalog) return a2uiBasicManifest;
  return createClientManifest(catalog, {
    app: 'a2ui',
    platform: 'any',
    version: '1.0.0',
  });
}

const COMMON = 'common_types.json#/$defs/';

/** A JSON Schema for one component, at one version, as A2UI catalog definitions write them. */
function componentSchema(
  type: string,
  definition: ComponentDefinition,
  version: number,
): Record<string, unknown> {
  const declared = definition.contract.schemas?.[String(version)];
  const props =
    isRecord(declared) && isRecord(declared['properties'])
      ? declared['properties']
      : null;
  const properties: Record<string, unknown> = {
    component: { const: type },
    ...(props ?? {}),
  };
  for (const [slot, spec] of Object.entries(definition.slots ?? {})) {
    if (spec.since !== undefined && spec.since > version) continue;
    if (spec.a2ui)
      properties[spec.a2ui.list] = {
        type: 'array',
        items: {
          type: 'object',
          properties: { [spec.a2ui.key]: { $ref: `${COMMON}ComponentId` } },
          required: [spec.a2ui.key],
          additionalProperties: true,
        },
      };
    else
      properties[slot] = {
        $ref: `${COMMON}${spec.max === 1 ? 'ComponentId' : 'ChildList'}`,
      };
  }
  for (const name of definition.a2ui?.actions ?? [])
    properties[name] = { $ref: `${COMMON}Action` };
  const required = [
    'component',
    ...(Array.isArray(
      declared && (declared as Record<string, unknown>)['required'],
    )
      ? ((declared as Record<string, unknown>)['required'] as string[])
      : []),
  ];
  return {
    type: 'object',
    allOf: [{ $ref: `${COMMON}Checkable` }],
    properties,
    required,
    // A contract without a schema says nothing about its props; the catalog then accepts any.
    ...(props === null ? { additionalProperties: true } : {}),
  };
}

export interface A2uiCatalogDefinition {
  readonly $schema: string;
  readonly catalogId: string;
  readonly protocolVersion: '1.0';
  readonly title?: string;
  readonly instructions?: string;
  readonly components: Readonly<Record<string, unknown>>;
  readonly functions: Readonly<Record<string, unknown>>;
  readonly $defs: {
    readonly anyComponent: unknown;
    readonly anyFunction: unknown;
  };
}

/**
 * The A2UI catalog definition for a catalog — at the newest versions without a manifest (what an
 * agent is given), or at one manifest's versions (what that renderer's id names).
 */
export function a2uiCatalogFor(
  catalog: SduiCatalog,
  manifest?: ClientManifest,
): A2uiCatalogDefinition {
  const components: Record<string, unknown> = {};
  for (const [type, definition] of Object.entries(catalog.components)) {
    const version = manifest
      ? own(manifest.components, type)
      : definition.contract.current;
    if (version === undefined) continue;
    components[type] = componentSchema(type, definition, version);
  }
  const functions: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(catalog.functions ?? {})) {
    if (manifest?.functions !== undefined && !manifest.functions.includes(name))
      continue;
    functions[name] = {
      type: 'object',
      ...(fn.description ? { description: fn.description } : {}),
      properties: {
        '@call': { const: name },
        args: isRecord(fn.args) ? fn.args : { type: 'object' },
      },
      required: ['@call'],
      returnType: fn.returnType,
      ...(fn.allowedCallers ? { allowedCallers: fn.allowedCallers } : {}),
      ...(fn.requiresUserActivation ? { requiresUserActivation: true } : {}),
    };
  }
  const refs = (section: string, names: readonly string[]) =>
    names.length > 0
      ? {
          oneOf: names.map((name) => ({
            $ref: `#/${section}/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`,
          })),
        }
      : false;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    catalogId: a2uiCatalogId(catalog, manifest),
    protocolVersion: '1.0',
    ...(catalog.a2ui?.title ? { title: catalog.a2ui.title } : {}),
    ...(catalog.a2ui?.instructions
      ? { instructions: catalog.a2ui.instructions }
      : {}),
    components,
    functions,
    $defs: {
      anyComponent: refs('components', Object.keys(components)),
      anyFunction: refs('functions', Object.keys(functions)),
    },
  };
}

/** What a renderer may say about itself: `a2uiRendererCapabilities` in transport metadata. */
export interface A2uiRendererCapabilities {
  readonly supportedCatalogIds: readonly string[];
}

/** Everything the server can serve: catalogs, and the manifests registered for them. */
export interface A2uiRegistry {
  readonly catalogs: readonly SduiCatalog[];
  readonly manifests: readonly ClientManifest[];
}

export type CapabilityResolution =
  | {
      readonly status: 'ok';
      readonly catalog: SduiCatalog;
      readonly manifest: ClientManifest;
      /** The id the renderer named, which surfaces sent to it carry. */
      readonly catalogId: string;
    }
  /** None of the ids is one this server knows — the handshake's `manifest-unknown`. */
  | {
      readonly status: 'manifest-unknown';
      readonly supportedCatalogIds: readonly string[];
    }
  /** The renderer does not speak v1.0 — the handshake's `protocol-unsupported`. */
  | {
      readonly status: 'protocol-unsupported';
      readonly versions: readonly string[];
    };

const CAPABILITY_LIMITS = { ids: 64, id: 512 };

/**
 * Reads `a2uiRendererCapabilities` — `{ "1.0": { supportedCatalogIds } }` — as a device sent it.
 * Throws `TypeError` for something that is not capabilities at all; a renderer that speaks only
 * other versions is not an error here, it is `protocol-unsupported` from
 * {@link resolveRendererCapabilities}.
 */
export function parseRendererCapabilities(raw: unknown): {
  readonly versions: readonly string[];
  readonly v1?: A2uiRendererCapabilities;
} {
  if (!isRecord(raw))
    throw new TypeError(
      'a2ui capabilities: must be an object keyed by protocol version',
    );
  const versions = Object.keys(raw).slice(0, 16);
  const v1 = raw['1.0'];
  if (v1 === undefined) return { versions };
  const ids = isRecord(v1) ? v1['supportedCatalogIds'] : undefined;
  if (
    !Array.isArray(ids) ||
    ids.length > CAPABILITY_LIMITS.ids ||
    !ids.every(
      (id) =>
        typeof id === 'string' &&
        id.length > 0 &&
        id.length <= CAPABILITY_LIMITS.id,
    )
  )
    throw new TypeError(
      `a2ui capabilities: "1.0".supportedCatalogIds must be an array of at most ${CAPABILITY_LIMITS.ids} catalog ids`,
    );
  return { versions, v1: { supportedCatalogIds: ids as string[] } };
}

/**
 * Which manifest a renderer is, from the catalog ids it supports — the first one this server knows,
 * in the renderer's order of preference. The basic catalog is always known.
 */
export function resolveRendererCapabilities(
  raw: unknown,
  registry: A2uiRegistry,
): CapabilityResolution {
  const { versions, v1 } = parseRendererCapabilities(raw);
  if (!v1) return { status: 'protocol-unsupported', versions };
  const byFingerprint = new Map(
    registry.manifests.map((manifest) => [
      manifestFingerprint(manifest),
      manifest,
    ]),
  );
  for (const id of v1.supportedCatalogIds) {
    if (id === A2UI_BASIC_CATALOG_ID)
      return {
        status: 'ok',
        catalog: a2uiBasicCatalog,
        manifest: a2uiBasicManifest,
        catalogId: id,
      };
    for (const catalog of registry.catalogs) {
      const base = catalog.a2ui?.catalogId;
      if (base === undefined) continue;
      if (id === base)
        return {
          status: 'ok',
          catalog,
          manifest: a2uiNewestManifest(catalog),
          catalogId: id,
        };
      const prefix = `${base}${base.includes('?') ? '&' : '?'}${MANIFEST_PARAM}=`;
      if (!id.startsWith(prefix)) continue;
      const manifest = byFingerprint.get(id.slice(prefix.length));
      if (manifest && fits(manifest, catalog))
        return { status: 'ok', catalog, manifest, catalogId: id };
    }
  }
  return {
    status: 'manifest-unknown',
    supportedCatalogIds: v1.supportedCatalogIds,
  };
}

/** A manifest names only components this catalog has, at versions it covers. */
function fits(manifest: ClientManifest, catalog: SduiCatalog): boolean {
  return Object.entries(manifest.components).every(([type, version]) => {
    const definition = own(catalog.components, type);
    return definition !== undefined && version <= definition.contract.current;
  });
}
