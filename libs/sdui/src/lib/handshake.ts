import { compareVersions } from './conditions.js';
import {
  type ClientManifest,
  SDUI_PROTOCOL_VERSION,
  manifestFingerprint,
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
  /** `false` when the delivery or user token was rejected. */
  readonly authorized?: boolean;
  /** The floor. Below it a binary is retired: it is told to update and is served nothing. */
  readonly requiredVersion?: string;
  /** Below this a binary still works, and is nudged. */
  readonly recommendedVersion?: string;
  /** Whether a fingerprint is registered. */
  readonly knowsManifest: (fingerprint: string) => boolean;
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
 *    outcome, not an error — and the screen it leads to is native, never server-driven.
 * 5. **Unknown manifest** — the device resends it in full.
 * 6. **Recommended update**, then `ok`.
 */
export function resolveHandshake(
  request: HandshakeRequest,
  policy: HandshakePolicy,
): HandshakeResolution {
  const [serverMin, serverMax] = policy.protocol ?? [
    SDUI_PROTOCOL_VERSION,
    SDUI_PROTOCOL_VERSION,
  ];
  const [clientMin, clientMax] = request.protocol;
  const protocol = Math.min(serverMax, clientMax);
  if (protocol < Math.max(serverMin, clientMin))
    return { status: 'protocol-unsupported', httpStatus: 426 };

  if (policy.maintenance)
    return { status: 'maintenance', httpStatus: 503, protocol };
  if (policy.authorized === false)
    return { status: 'unauthorized', httpStatus: 401, protocol };

  const update = {
    ...(policy.requiredVersion !== undefined
      ? { required: policy.requiredVersion }
      : {}),
    ...(policy.recommendedVersion !== undefined
      ? { recommended: policy.recommendedVersion }
      : {}),
  };
  if (
    policy.requiredVersion !== undefined &&
    compareVersions(request.app.version, policy.requiredVersion) < 0
  ) {
    return { status: 'update-required', httpStatus: 200, protocol, update };
  }

  const fingerprint =
    typeof request.manifest === 'string'
      ? request.manifest
      : manifestFingerprint(request.manifest);
  if (
    typeof request.manifest === 'string' &&
    !policy.knowsManifest(fingerprint)
  ) {
    return { status: 'manifest-unknown', httpStatus: 409, protocol };
  }

  const behind =
    policy.recommendedVersion !== undefined &&
    compareVersions(request.app.version, policy.recommendedVersion) < 0;
  const degraded =
    policy.degradedShare !== undefined &&
    policy.degradedShare > (policy.degradedThreshold ?? 0.25);
  return {
    status: behind || degraded ? 'update-recommended' : 'ok',
    httpStatus: 200,
    protocol,
    manifest: fingerprint,
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
   * - `ignore-stale` — older than what the device has seen: a lagging replica. Do not go back.
   * - `conflict` — the same `seq` naming a different release. Should not happen; keep and report.
   */
  readonly action: 'adopt' | 'keep' | 'ignore-stale' | 'conflict';
  /** Whether adopting changes which release the device shows. */
  readonly changed: boolean;
  /** The server moved the environment *back* on purpose. */
  readonly rolledBack: boolean;
}

/**
 * Tells a rollback from a stale replica.
 *
 * Both hand a device an older release. Obeying a stale replica makes a device flap between two
 * releases, or loop; ignoring a rollback leaves a broken release on screen. Comparing releases
 * cannot tell them apart — but a rollback is a *new* move, so it carries a *higher* sequence
 * number, and a lagging replica by definition carries a lower one. So a device never accepts a
 * lower `seq` than it has seen, and always accepts a higher one, whatever it points at.
 */
export function decidePointer(
  known: { readonly release: string; readonly seq: number } | null | undefined,
  offered: ReleasePointer,
): PointerDecision {
  if (!known) return { action: 'adopt', changed: true, rolledBack: false };
  if (offered.seq < known.seq)
    return { action: 'ignore-stale', changed: false, rolledBack: false };
  const changed = offered.release !== known.release;
  if (offered.seq === known.seq)
    return {
      action: changed ? 'conflict' : 'keep',
      changed: false,
      rolledBack: false,
    };
  return { action: 'adopt', changed, rolledBack: offered.kind === 'rollback' };
}
