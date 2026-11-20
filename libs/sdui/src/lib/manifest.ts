import { parseVersion } from './conditions.js';
import { contentAddress } from './hash.js';
import { isRecord, own } from './internal.js';
import type { SduiCatalog } from './catalog.js';

/**
 * The client manifest — what one binary can render.
 *
 * Generated when the app is built, from the component versions it actually implements. A device
 * sends only the manifest's fingerprint at handshake; the app's release job has already
 * registered the full document, so the server knows the population it has to serve before the
 * first of them calls.
 */
export interface ClientManifest {
  readonly sduiManifest: '1';
  /** The inclusive range of wire-protocol versions this binary speaks. */
  readonly protocol: readonly [min: number, max: number];
  readonly app: string;
  readonly platform: string;
  /** The app's marketing version, dotted numbers: `5.8.0`. */
  readonly version: string;
  readonly build?: number;
  /** Component type → the contract version this binary renders. */
  readonly components: Readonly<Record<string, number>>;
  readonly actions?: Readonly<Record<string, number>>;
  /**
   * The catalog functions this binary implements, for bound values. Absent means the manifest
   * predates functions and says nothing about them; present, a call to any other is unsupported.
   */
  readonly functions?: readonly string[];
  /** Asset formats this binary decodes. */
  readonly assets?: readonly string[];
  readonly limits?: { readonly depth?: number; readonly bytes?: number };
}

export const MANIFEST_ID_PREFIX = 'cm_';

/** The wire-protocol version this package implements. */
export const SDUI_PROTOCOL_VERSION = 1;

/** How much a manifest may hold. A device can send one unauthenticated, so it is bounded. */
export const MANIFEST_LIMITS = Object.freeze({
  types: 2_000,
  assets: 64,
  name: 128,
});

const MANIFEST_KEYS = [
  'sduiManifest',
  'protocol',
  'app',
  'platform',
  'version',
  'build',
  'components',
  'actions',
  'functions',
  'assets',
  'limits',
];
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * A manifest's fingerprint. Key order never matters, so two build machines that emit the same
 * document emit the same fingerprint. Array order does: `assets` is part of what is addressed.
 */
export function manifestFingerprint(manifest: ClientManifest): string {
  return contentAddress(MANIFEST_ID_PREFIX, manifest);
}

/**
 * Validates an untrusted value as a client manifest. Throws `TypeError` naming the first problem.
 *
 * Strict about unknown keys on purpose: the fingerprint covers the whole document, so a manifest
 * that could carry arbitrary extra fields could be given unlimited fingerprints, each one a new
 * entry in whatever is cached per manifest.
 */
export function parseClientManifest(raw: unknown): ClientManifest {
  const fail = (message: string): never => {
    throw new TypeError(`sdui manifest: ${message}`);
  };
  if (!isRecord(raw)) return fail('document must be an object');
  const unknown = Object.keys(raw).find((key) => !MANIFEST_KEYS.includes(key));
  if (unknown !== undefined) fail(`unknown key "${unknown}"`);
  if (raw['sduiManifest'] !== '1')
    fail(
      `unsupported manifest format "${String(raw['sduiManifest'])}" — this reader understands "1"`,
    );

  const protocol = raw['protocol'];
  if (
    !Array.isArray(protocol) ||
    protocol.length !== 2 ||
    !protocol.every((v) => Number.isSafeInteger(v) && v >= 1) ||
    protocol[0] > protocol[1]
  ) {
    fail('protocol must be [min, max], two positive integers in order');
  }
  const isName = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MANIFEST_LIMITS.name;
  for (const key of ['app', 'platform', 'version'] as const) {
    if (!isName(raw[key]))
      fail(
        `${key} must be a non-empty string of at most ${MANIFEST_LIMITS.name} characters`,
      );
  }
  if (!parseVersion(raw['version']))
    fail(`version must be dotted numbers, got "${String(raw['version'])}"`);
  if (
    raw['build'] !== undefined &&
    (!Number.isSafeInteger(raw['build']) || (raw['build'] as number) < 0)
  )
    fail('build must be a whole number');

  const versions = (key: 'components' | 'actions', required: boolean): void => {
    const map = raw[key];
    if (map === undefined && !required) return;
    if (!isRecord(map))
      return fail(`${key} must be an object of type → version`);
    const entries = Object.entries(map);
    if (entries.length > MANIFEST_LIMITS.types)
      fail(`${key} has more than ${MANIFEST_LIMITS.types} entries`);
    for (const [type, version] of entries) {
      if (!isName(type) || RESERVED.has(type))
        fail(
          `${key} has an entry named ${JSON.stringify(type.slice(0, 40))}, which is not a type name`,
        );
      if (!Number.isSafeInteger(version) || (version as number) < 1)
        fail(`${key}.${type} must be a positive integer version`);
    }
  };
  versions('components', true);
  versions('actions', false);

  const functions = raw['functions'];
  if (
    functions !== undefined &&
    (!Array.isArray(functions) ||
      functions.length > MANIFEST_LIMITS.types ||
      !functions.every((name) => isName(name) && !RESERVED.has(name)))
  )
    fail(
      `functions must be an array of at most ${MANIFEST_LIMITS.types} function names`,
    );

  const assets = raw['assets'];
  if (
    assets !== undefined &&
    (!Array.isArray(assets) ||
      assets.length > MANIFEST_LIMITS.assets ||
      !assets.every(isName))
  ) {
    fail(
      `assets must be an array of at most ${MANIFEST_LIMITS.assets} format names`,
    );
  }
  const limits = raw['limits'];
  if (limits !== undefined) {
    if (!isRecord(limits)) return fail('limits must be an object');
    for (const [key, value] of Object.entries(limits)) {
      if (key !== 'depth' && key !== 'bytes')
        fail(`limits has an unknown key "${key}"`);
      if (!Number.isSafeInteger(value) || (value as number) < 1)
        fail(`limits.${key} must be a positive integer`);
    }
  }
  return raw as unknown as ClientManifest;
}

export interface CreateManifestOptions {
  readonly app: string;
  readonly platform: string;
  readonly version: string;
  readonly build?: number;
  /**
   * Versions this binary implements where they differ from the catalog's newest: `{ "hero-banner":
   * 1 }`. A type mapped to `0` is left out — this binary does not have it at all.
   */
  readonly pin?: Readonly<Record<string, number>>;
  readonly assets?: readonly string[];
  readonly limits?: ClientManifest['limits'];
  readonly protocol?: readonly [number, number];
  /**
   * The catalog functions this binary implements. Defaults to every function the catalog has,
   * when it has any.
   */
  readonly functions?: readonly string[];
}

/**
 * Builds the manifest for a binary that implements a catalog, at the catalog's newest versions
 * unless pinned lower. This is what `sdui manifest gen` writes.
 */
export function createClientManifest(
  catalog: SduiCatalog,
  options: CreateManifestOptions,
): ClientManifest {
  const pick = (
    kind: string,
    entries: Readonly<Record<string, { contract: { current: number } }>> = {},
  ): Record<string, number> => {
    const out: [string, number][] = [];
    for (const [type, entry] of Object.entries(entries)) {
      const pinned = own(options.pin, type);
      if (pinned === 0) continue;
      const version = pinned ?? entry.contract.current;
      if (
        !Number.isInteger(version) ||
        version < 1 ||
        version > entry.contract.current
      ) {
        throw new TypeError(
          `sdui manifest: cannot pin ${kind} "${type}" at v${version} — the catalog covers v1 through v${entry.contract.current}`,
        );
      }
      out.push([type, version]);
    }
    return Object.fromEntries(out);
  };
  for (const type of Object.keys(options.pin ?? {})) {
    if (
      own(catalog.components, type) === undefined &&
      own(catalog.actions, type) === undefined
    ) {
      throw new TypeError(
        `sdui manifest: cannot pin "${type}" — the catalog has no component or action by that name`,
      );
    }
  }
  const actions = pick('action', catalog.actions);
  const functions =
    options.functions ?? Object.keys(catalog.functions ?? {}).sort();
  for (const name of options.functions ?? [])
    if (own(catalog.functions, name) === undefined)
      throw new TypeError(
        `sdui manifest: "${name}" is not a function in the catalog`,
      );
  return parseClientManifest({
    sduiManifest: '1',
    protocol: options.protocol ?? [
      SDUI_PROTOCOL_VERSION,
      SDUI_PROTOCOL_VERSION,
    ],
    app: options.app,
    platform: options.platform,
    version: options.version,
    ...(options.build !== undefined ? { build: options.build } : {}),
    components: pick('component', catalog.components),
    ...(Object.keys(actions).length > 0 ? { actions } : {}),
    ...(functions.length > 0 ? { functions: [...functions] } : {}),
    ...(options.assets ? { assets: [...options.assets] } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  });
}
