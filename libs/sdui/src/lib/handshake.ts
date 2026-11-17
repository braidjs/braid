import { compareVersions, parseVersion } from './conditions.js';
import { isRecord } from './internal.js';
import {
  type ClientManifest,
  SDUI_PROTOCOL_VERSION,
  manifestFingerprint,
  parseClientManifest,
} from './manifest.js';
import type { ApplyBoundary } from './rollout.js';

/**
 * The handshake — where a device and a server find out whether they can work together, before
 * either sends the other anything it might not understand.
 *
 * Pure decision logic only: what to answer given what the device said and what the server knows.
 * Transport, tokens and storage belong to the delivery API.
 */

export interface HandshakeRequest {
  /** The inclusive range of wire-protocol versions the device speaks. */
  readonly protocol: readonly [min: number, max: number];
  /** A registered manifest's fingerprint — or the whole manifest, after a `manifest-unknown`. */
  readonly manifest: string | ClientManifest;
  readonly app: {
    readonly id: string;
    readonly platform: string;
    readonly version: string;
    readonly build?: number;
  };
  /** Pseudonymous and resettable. Buckets rollouts and flags. */
  readonly install?: string;
  /** The pointer the device last adopted, so the server can tell it nothing changed. */
  readonly known?: { readonly release: string; readonly seq: number };
}

export type HandshakeStatus =
  | 'ok'
  | 'update-recommended'
  | 'update-required'
  | 'protocol-unsupported'
  | 'manifest-unknown'
  | 'maintenance'
  | 'unauthorized';

export const HANDSHAKE_STATUSES = [
  'ok',
  'update-recommended',
  'update-required',
  'protocol-unsupported',
  'manifest-unknown',
  'maintenance',
  'unauthorized',
] as const satisfies readonly HandshakeStatus[];

export interface HandshakePolicy {
  /** Protocol versions this server speaks. Defaults to this package's version alone. */
  readonly protocol?: readonly [min: number, max: number];
  /** The global kill switch for this app and environment. */
  readonly maintenance?: boolean;
  /**
   * Whether the caller may be served. Required, and only `true` passes: a delivery API with no
   * tokens says so by passing `true`, rather than by leaving a field out.
   */
  readonly authorized: boolean;
  /** The floor. Below it a binary is retired: it is told to update and is served nothing. */
  readonly requiredVersion?: string;
  /** Below this a binary still works, and is nudged. */
  readonly recommendedVersion?: string;
  /** Whether a fingerprint is registered. */
  readonly knowsManifest: (fingerprint: string) => boolean;
  /**
   * The app version in the *registered* manifest for this fingerprint, when the caller has it.
   * It is used in place of what the request claims: a device reports its own version, and one
   * that wanted past the floor would report a high one.
   */
  readonly registeredVersion?: string;
  /**
   * The share of this manifest's nodes that render degraded or as a fallback in the release it
   * would be served, 0–1, when the caller has it. Above `degradedThreshold` the device is nudged
   * to update even if its version is above the recommended one.
   */
  readonly degradedShare?: number;
  readonly degradedThreshold?: number;
}

export interface HandshakeResolution {
  readonly status: HandshakeStatus;
  /** The HTTP status the delivery API answers with. */
  readonly httpStatus: number;
  /** The protocol version both sides will speak. Absent when they share none. */
  readonly protocol?: number;
  /** The fingerprint the device is known by, once it is known. */
  readonly manifest?: string;
  /**
   * Whether that fingerprint was registered by a release job. `false` for a manifest a device
   * sent in full that nobody registered: servable, but its capabilities are its own word.
   */
  readonly registered?: boolean;
  readonly update?: {
    readonly required?: string;
    readonly recommended?: string;
  };
}

/**
 * Decides the answer to a handshake. The order is the design:
 *
 * 1. **Protocol** first — with no version in common nothing else in the answer can be read.
 * 2. **Maintenance** — the switch that turns everything off must not depend on anything below it.
 * 3. **Authorization.**
 * 4. **The floor** before the manifest: a retired binary is told to update, not asked to upload a
 *    manifest for a server that will never render for it. This is skew's `retired` — a policy
 *    outcome, not an error — and the screen it leads to is native, never server-driven. A version
 *    that cannot be read is below any floor.
 * 5. **Unknown manifest** — the device resends it in full (409). A manifest sent in full that is
 *    not a manifest is answered the same way with 400: there is nothing to resend.
 * 6. **Recommended update**, then `ok`.
 *
 * Throws `TypeError` for a policy that is itself malformed (a floor that is not a version): that
 * is a deployment mistake, and answering every device `ok` because of it would hide it.
 */
export function resolveHandshake(
  request: HandshakeRequest,
  policy: HandshakePolicy,
): HandshakeResolution {
  for (const key of [
    'requiredVersion',
    'recommendedVersion',
    'registeredVersion',
  ] as const) {
    if (policy[key] !== undefined && !parseVersion(policy[key])) {
      throw new TypeError(
        `sdui handshake: policy.${key} must be a version of dotted numbers, got ${JSON.stringify(policy[key])}`,
      );
    }
  }

  const [serverMin, serverMax] = policy.protocol ?? [
    SDUI_PROTOCOL_VERSION,
    SDUI_PROTOCOL_VERSION,
  ];
  const [clientMin, clientMax] = request.protocol;
  const protocol = Math.min(serverMax, clientMax);
  if (!(protocol >= Math.max(serverMin, clientMin)))
    return { status: 'protocol-unsupported', httpStatus: 426 };

  if (policy.maintenance)
    return { status: 'maintenance', httpStatus: 503, protocol };
  if (policy.authorized !== true)
    return { status: 'unauthorized', httpStatus: 401, protocol };

  const update = {
    ...(policy.requiredVersion !== undefined
      ? { required: policy.requiredVersion }
      : {}),
    ...(policy.recommendedVersion !== undefined
      ? { recommended: policy.recommendedVersion }
      : {}),
  };
  // A manifest sent in full is checked here too, not only in `parseHandshakeRequest`: this
  // function is the one that decides, and must not decide `ok` for something that is not a
  // manifest because a caller skipped the parser.
  let sent: ClientManifest | null = null;
  if (typeof request.manifest !== 'string') {
    try {
      sent = parseClientManifest(request.manifest);
    } catch {
      return { status: 'manifest-unknown', httpStatus: 400, protocol };
    }
  }
  const version =
    policy.registeredVersion ?? (sent ? sent.version : request.app.version);
  const below = (bound: string | undefined): boolean => {
    if (bound === undefined) return false;
    const order = compareVersions(version, bound);
    return order === null || order < 0;
  };
  if (below(policy.requiredVersion))
    return { status: 'update-required', httpStatus: 200, protocol, update };

  const fingerprint = sent
    ? manifestFingerprint(sent)
    : (request.manifest as string);
  const registered = policy.knowsManifest(fingerprint) === true;
  if (!sent && !registered)
    return { status: 'manifest-unknown', httpStatus: 409, protocol };

  const degraded =
    typeof policy.degradedShare === 'number' &&
    policy.degradedShare > (policy.degradedThreshold ?? 0.25);
  return {
    status:
      below(policy.recommendedVersion) || degraded
        ? 'update-recommended'
        : 'ok',
    httpStatus: 200,
    protocol,
    manifest: fingerprint,
    registered,
    ...(Object.keys(update).length > 0 ? { update } : {}),
  };
}

// --- the sequence rule -------------------------------------------------------

/** What an environment points at, and how many times it has been moved. */
export interface ReleasePointer {
  readonly release: string;
  /** Goes up by one each time the environment's pointer moves, in any direction. */
  readonly seq: number;
  readonly kind?: 'promote' | 'rollout' | 'rollback';
  readonly apply?: ApplyBoundary;
}

export interface PointerDecision {
  /**
   * - `adopt` — newer than anything seen: follow it.
   * - `keep` — the same move the device already has.
   * - `ignore-stale` — older than what the device has seen, or not a pointer at all. Do not move.
   * - `conflict` — the same `seq` naming a different release. Should not happen; keep and report.
   */
  readonly action: 'adopt' | 'keep' | 'ignore-stale' | 'conflict';
  /** Whether adopting changes which release the device shows. */
  readonly changed: boolean;
  /** The server moved the environment *back* on purpose, and this device has to move with it. */
  readonly rolledBack: boolean;
}

const isSeq = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isRelease = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128;

/**
 * Tells a rollback from a stale replica.
 *
 * Both hand a device an older release. Obeying a stale replica makes a device flap between two
 * releases, or loop; ignoring a rollback leaves a broken release on screen. Comparing releases
 * cannot tell them apart — but a rollback is a *new* move, so it carries a *higher* sequence
 * number, and a lagging replica by definition carries a lower one. So a device never accepts a
 * lower `seq` than it has seen, and always accepts a higher one, whatever it points at.
 *
 * An offered pointer that is not well formed — a `seq` that is missing, fractional, a string — is
 * never adopted. This runs on a device against whatever a network handed it.
 */
export function decidePointer(
  known: { readonly release: string; readonly seq: number } | null | undefined,
  offered: ReleasePointer,
): PointerDecision {
  const stay: PointerDecision = {
    action: 'ignore-stale',
    changed: false,
    rolledBack: false,
  };
  if (!isRecord(offered) || !isSeq(offered.seq) || !isRelease(offered.release))
    return stay;
  // A device whose own record is unreadable has seen nothing it can compare against.
  if (!known || !isSeq(known.seq) || !isRelease(known.release))
    return { action: 'adopt', changed: true, rolledBack: false };
  if (offered.seq < known.seq) return stay;
  const changed = offered.release !== known.release;
  if (offered.seq === known.seq)
    return {
      action: changed ? 'conflict' : 'keep',
      changed: false,
      rolledBack: false,
    };
  return {
    action: 'adopt',
    changed,
    rolledBack: changed && offered.kind === 'rollback',
  };
}

/** Validates an untrusted value as a release pointer. Throws `TypeError` naming the problem. */
export function parseReleasePointer(raw: unknown): ReleasePointer {
  const fail = (message: string): never => {
    throw new TypeError(`sdui pointer: ${message}`);
  };
  if (!isRecord(raw)) return fail('must be an object');
  if (!isRelease(raw['release']))
    fail('release must be a non-empty string of at most 128 characters');
  if (!isSeq(raw['seq'])) fail('seq must be a non-negative integer');
  if (
    raw['kind'] !== undefined &&
    !['promote', 'rollout', 'rollback'].includes(raw['kind'] as string)
  )
    fail('kind must be promote, rollout or rollback');
  if (
    raw['apply'] !== undefined &&
    !['next-launch', 'next-navigation', 'immediate'].includes(
      raw['apply'] as string,
    )
  )
    fail('apply must be next-launch, next-navigation or immediate');
  return raw as unknown as ReleasePointer;
}

const INSTALL = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Validates an untrusted handshake body. A handshake is the first thing an unauthenticated device
 * sends, so this is the outermost boundary of the whole system: it throws `TypeError` naming the
 * first problem, and nothing malformed gets as far as {@link resolveHandshake}.
 *
 * A manifest sent in full is validated here too, and must describe the app the request says it
 * is: a device cannot present one binary's capabilities under another's name.
 */
export function parseHandshakeRequest(raw: unknown): HandshakeRequest {
  const fail = (message: string): never => {
    throw new TypeError(`sdui handshake: ${message}`);
  };
  const isText = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max;
  if (!isRecord(raw)) return fail('body must be an object');
  const unknown = Object.keys(raw).find(
    (key) =>
      !['protocol', 'manifest', 'app', 'install', 'known', 'device'].includes(
        key,
      ),
  );
  if (unknown !== undefined) fail(`unknown key "${unknown.slice(0, 40)}"`);

  const protocol = raw['protocol'];
  if (
    !Array.isArray(protocol) ||
    protocol.length !== 2 ||
    !protocol.every((v) => Number.isSafeInteger(v) && v >= 1) ||
    protocol[0] > protocol[1]
  ) {
    fail('protocol must be [min, max], two positive integers in order');
  }

  const app = raw['app'];
  if (!isRecord(app)) return fail('app must be an object');
  for (const key of ['id', 'platform', 'version'] as const) {
    if (!isText(app[key], 128))
      fail(`app.${key} must be a non-empty string of at most 128 characters`);
  }
  if (!parseVersion(app['version']))
    fail('app.version must be dotted numbers, like "5.8.0"');
  if (app['build'] !== undefined && !Number.isSafeInteger(app['build']))
    fail('app.build must be an integer');
  const strayApp = Object.keys(app).find(
    (key) => !['id', 'platform', 'version', 'build'].includes(key),
  );
  if (strayApp !== undefined)
    fail(`app has an unknown key "${strayApp.slice(0, 40)}"`);

  // `device` is free-form facts about the device (OS, locale, font scale…): a flat record of
  // short scalars, and nothing a parser downstream could trip over.
  const device = raw['device'];
  if (device !== undefined) {
    if (!isRecord(device)) return fail('device must be an object');
    const entries = Object.entries(device);
    if (entries.length > 32) fail('device has more than 32 entries');
    for (const [key, value] of entries) {
      if (
        !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key) ||
        key === 'constructor' ||
        key === 'prototype'
      )
        fail(
          `device has a key ${JSON.stringify(key.slice(0, 40))} that is not a short plain word`,
        );
      const scalar =
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.length <= 128);
      if (!scalar)
        fail(
          `device.${key} must be a boolean, a number or a string of at most 128 characters`,
        );
    }
  }

  const manifest = raw['manifest'];
  if (isRecord(manifest)) {
    const parsed = parseClientManifest(manifest);
    if (
      parsed.app !== app['id'] ||
      parsed.platform !== app['platform'] ||
      parsed.version !== app['version']
    ) {
      fail(
        'manifest describes a different app, platform or version than the request does',
      );
    }
  } else if (!isText(manifest, 128)) {
    fail('manifest must be a fingerprint or a manifest document');
  }

  if (
    raw['install'] !== undefined &&
    (typeof raw['install'] !== 'string' || !INSTALL.test(raw['install']))
  ) {
    fail('install must be 1 to 128 letters, digits, ".", "_", ":" or "-"');
  }
  const known = raw['known'];
  if (known !== undefined && known !== null) {
    if (
      !isRecord(known) ||
      !isRelease(known['release']) ||
      !isSeq(known['seq'])
    )
      fail('known must be { release, seq } with a non-negative integer seq');
  }
  return raw as unknown as HandshakeRequest;
}
