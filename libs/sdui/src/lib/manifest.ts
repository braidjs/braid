import { contentAddress } from './hash.js';
import { isRecord } from './model.js';
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
  /** Asset formats this binary decodes. */
  readonly assets?: readonly string[];
  readonly limits?: { readonly depth?: number; readonly bytes?: number };
}

export const MANIFEST_ID_PREFIX = 'cm_';

/** The wire-protocol version this package implements. */
export const SDUI_PROTOCOL_VERSION = 1;

/**
 * A manifest's fingerprint. Key order never matters, so two build machines that emit the same
 * capabilities emit the same fingerprint.
 */
export function manifestFingerprint(manifest: ClientManifest): string {
  return contentAddress(MANIFEST_ID_PREFIX, manifest);
}

export function parseClientManifest(raw: unknown): ClientManifest {
  const fail = (message: string): never => {
    throw new TypeError(`sdui manifest: ${message}`);
  };
  if (!isRecord(raw)) return fail('document must be an object');
  if (raw['sduiManifest'] !== '1')
    fail(
      `unsupported manifest format "${String(raw['sduiManifest'])}" — this reader understands "1"`,
    );

  const protocol = raw['protocol'];
  if (
    !Array.isArray(protocol) ||
    protocol.length !== 2 ||
    !protocol.every((v) => Number.isInteger(v) && v >= 1) ||
    protocol[0] > protocol[1]
  ) {
    fail('protocol must be [min, max], two positive integers in order');
  }
  for (const key of ['app', 'platform', 'version'] as const) {
    if (typeof raw[key] !== 'string' || raw[key].length === 0)
      fail(`${key} must be a non-empty string`);
  }
  if (!/^\d+(\.\d+)*$/.test(raw['version'] as string))
    fail(`version must be dotted numbers, got "${String(raw['version'])}"`);
  if (raw['build'] !== undefined && !Number.isInteger(raw['build']))
    fail('build must be an integer');

  const versions = (key: 'components' | 'actions', required: boolean): void => {
    const map = raw[key];
    if (map === undefined && !required) return;
    if (!isRecord(map))
      return fail(`${key} must be an object of type → version`);
    for (const [type, version] of Object.entries(map)) {
      if (!Number.isInteger(version) || (version as number) < 1)
        fail(`${key}.${type} must be a positive integer version`);
    }
  };
  versions('components', true);
  versions('actions', false);

  if (
    raw['assets'] !== undefined &&
    (!Array.isArray(raw['assets']) ||
      !raw['assets'].every((a) => typeof a === 'string'))
  ) {
    fail('assets must be an array of format names');
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
    const out: Record<string, number> = {};
    for (const [type, entry] of Object.entries(entries)) {
      const pinned = options.pin?.[type];
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
      out[type] = version;
    }
    return out;
  };
  for (const type of Object.keys(options.pin ?? {})) {
    if (!(type in catalog.components) && !(type in (catalog.actions ?? {}))) {
      throw new TypeError(
        `sdui manifest: cannot pin "${type}" — the catalog has no component or action by that name`,
      );
    }
  }
  const actions = pick('action', catalog.actions);
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
    ...(options.assets ? { assets: [...options.assets] } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  });
}
