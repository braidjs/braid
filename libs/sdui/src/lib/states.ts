import type { HandshakeStatus, PointerDecision } from './handshake.js';
import type { NodeOutcome, ProjectionOutcome } from './projection.js';

/**
 * Every state a server-driven app can be in, by name.
 *
 * The lists below are the specification. A client in any language implements the four resolvers
 * and is checked against the vectors in `conformance/states/`; `tools/sdui/check-state-matrix.mjs`
 * fails the build when a name here has no vector. Adding a state is therefore never just adding a
 * string: it has to say when it happens and what the user sees.
 *
 * The resolvers are pure. A client gathers facts — did the fetch fail, is there a cached copy,
 * what did projection say — and asks which state that is. Keeping the *decision* here, apart from
 * the networking and rendering that gather the facts, is what lets a Swift client, a Kotlin client
 * and the CMS's state switcher agree about it.
 */

// prettier-ignore
export const SESSION_STATES = [
  'first-launch-online', 'first-launch-offline', 'handshake-pending', 'handshake-timeout', 'ok',
  'update-recommended', 'update-required', 'protocol-unsupported', 'maintenance', 'principal-changed',
  'token-expired', 'release-superseded', 'rolled-back', 'stale-origin', 'clock-skewed', 'app-updated',
  'consent-changed',
] as const;

// prettier-ignore
export const SCREEN_STATES = [
  'loading-initial', 'loaded', 'loaded-revalidating', 'loaded-stale', 'refreshing', 'paginating',
  'pagination-error', 'end-of-list', 'partial', 'empty', 'error-network', 'error-server',
  'error-timeout', 'error-rate-limited', 'not-found', 'gone', 'moved', 'forbidden', 'not-yet-live',
  'expired', 'incompatible', 'decode-error', 'render-error',
] as const;

// prettier-ignore
export const NODE_STATES = [
  'exact', 'upgraded', 'downgraded', 'fallback-authored', 'fallback-catalog', 'omitted',
  'hidden-by-visibility', 'hidden-by-flag', 'variant', 'deferred-loading', 'deferred-error',
  'deferred-empty', 'data-loading', 'data-error', 'data-stale', 'disabled', 'asset-loading',
  'asset-error', 'asset-format-unsupported', 'string-missing', 'truncated',
] as const;

// prettier-ignore
export const ACTION_STATES = [
  'idle', 'unsupported', 'confirming', 'pending', 'succeeded', 'failed-retryable', 'failed-terminal',
  'queued-offline', 'requires-auth', 'target-missing', 'blocked-url', 'invalid', 'server-rejected',
  'draft-restored',
] as const;

export type SessionState = (typeof SESSION_STATES)[number];
export type ScreenState = (typeof SCREEN_STATES)[number];
export type NodeState = (typeof NODE_STATES)[number];
export type ActionState = (typeof ACTION_STATES)[number];

/**
 * Where the pixels come from. The further down this list, the less the server is involved — which
 * is the point of naming it: a state whose interface the server cannot supply must be one the
 * server is not needed for.
 */
export type UiSource =
  /** Fresh from the delivery API. */
  | 'server'
  /** The device's last good copy. */
  | 'cache'
  /** The skeleton that ships in the route table, available before any screen request. */
  | 'skeleton'
  /** A state designed for this screen in the CMS. */
  | 'authored-state'
  /** The app's system state: authored once in the CMS and also bundled in the binary. */
  | 'system-state'
  /** The newest earlier release this binary renders in full. */
  | 'earlier-release'
  /** The baseline projected for this binary at build time and shipped inside it. */
  | 'bundled'
  /** Hard-coded in the app. Never server-driven. */
  | 'native';

// --- session -----------------------------------------------------------------

export interface SessionFacts {
  /** How the handshake stands: still out, gave up waiting, could not connect, or its answer. */
  readonly handshake: 'pending' | 'timed-out' | 'unreachable' | HandshakeStatus;
  /** Whether this binary has a readable cached release. */
  readonly hasCache: boolean;
  /** What {@link decidePointer} said about the release the handshake offered. */
  readonly pointer?: PointerDecision;
  /** A session was already showing a release when this handshake completed. */
  readonly midSession?: boolean;
  /** The binary's manifest fingerprint differs from the one its cache was written under. */
  readonly manifestChanged?: boolean;
  /** The signed-in principal changed since the last handshake. */
  readonly principalChanged?: boolean;
  readonly consentRevoked?: boolean;
  /** Device clock minus server time, in milliseconds. */
  readonly clockSkewMs?: number;
}

/** Beyond this the device's clock is not to be trusted for anything; schedules already are not. */
export const CLOCK_SKEW_LIMIT_MS = 5 * 60_000;

/**
 * Which session state a set of facts is. Earlier lines win:
 *
 * 1. Answers that end the conversation — unsupported protocol, retired binary, maintenance.
 * 2. No answer yet, or none coming.
 * 3. An answer, with something about it the app must act on before carrying on.
 * 4. The ordinary cases.
 */
export function resolveSessionState(facts: SessionFacts): {
  state: SessionState;
  source: UiSource;
} {
  switch (facts.handshake) {
    case 'protocol-unsupported':
      return { state: 'protocol-unsupported', source: 'bundled' };
    case 'update-required':
      return { state: 'update-required', source: 'native' };
    case 'maintenance':
      return { state: 'maintenance', source: 'bundled' };
    case 'pending':
    case 'manifest-unknown': // the device resends its manifest; to the user this is still the splash
      return { state: 'handshake-pending', source: 'native' };
    case 'timed-out':
    case 'unreachable':
      // A cache written under another manifest is unreadable by design, so it does not count.
      return facts.hasCache && !facts.manifestChanged
        ? { state: 'handshake-timeout', source: 'cache' }
        : { state: 'first-launch-offline', source: 'bundled' };
    case 'unauthorized':
      return {
        state: 'token-expired',
        source: facts.hasCache ? 'cache' : 'bundled',
      };
  }

  if (facts.manifestChanged) return { state: 'app-updated', source: 'bundled' };
  if (facts.consentRevoked)
    return { state: 'consent-changed', source: 'server' };
  if (facts.principalChanged)
    return { state: 'principal-changed', source: 'server' };

  const pointer = facts.pointer;
  if (pointer?.action === 'ignore-stale' || pointer?.action === 'conflict')
    return { state: 'stale-origin', source: 'cache' };
  if (pointer?.action === 'adopt' && pointer.rolledBack)
    return { state: 'rolled-back', source: 'server' };
  if (pointer?.action === 'adopt' && pointer.changed && facts.midSession)
    return { state: 'release-superseded', source: 'cache' };

  if (Math.abs(facts.clockSkewMs ?? 0) > CLOCK_SKEW_LIMIT_MS)
    return { state: 'clock-skewed', source: 'server' };
  if (!facts.hasCache)
    return { state: 'first-launch-online', source: 'skeleton' };
  if (facts.handshake === 'update-recommended')
    return { state: 'update-recommended', source: 'server' };
  return { state: 'ok', source: 'server' };
}

// --- screen ------------------------------------------------------------------

export type ScreenFailure =
  | 'network'
  | 'server'
  | 'timeout'
  | 'rate-limited'
  | 'not-found'
  | 'gone'
  | 'moved'
  | 'forbidden'
  | 'not-yet-live'
  | 'expired'
  /** The payload arrived and the device could not decode it. */
  | 'decode';

export interface ScreenFacts {
  readonly fetch: 'idle' | 'in-flight' | 'ok' | 'failed';
  readonly failure?: ScreenFailure;
  /** A readable cached copy of this screen exists. */
  readonly cached: boolean;
  readonly projection?: ProjectionOutcome;
  /** The screen's data source answered with nothing. */
  readonly dataEmpty?: boolean;
  /** The user asked for the refresh that is in flight. */
  readonly refreshing?: boolean;
  readonly pagination?: 'loading' | 'failed' | 'end';
  /** The root node threw while rendering. */
  readonly renderFailed?: boolean;
}

const TRANSPORT_FAILURES: Partial<Record<ScreenFailure, ScreenState>> = {
  network: 'error-network',
  server: 'error-server',
  timeout: 'error-timeout',
  'rate-limited': 'error-rate-limited',
};

/**
 * Which screen state a set of facts is.
 *
 * The one rule worth remembering: a *transport* failure (network, 5xx, timeout, 429) shows the
 * cached copy when there is one, because the content is probably still right. A *semantic*
 * failure (gone, forbidden, expired) never does — the server has said this content is not for
 * this person now, and a cached copy would contradict it.
 */
export function resolveScreenState(facts: ScreenFacts): {
  state: ScreenState;
  source: UiSource;
} {
  if (facts.renderFailed)
    return { state: 'render-error', source: 'system-state' };

  if (facts.fetch === 'failed') {
    const failure = facts.failure ?? 'network';
    if (failure === 'decode')
      return {
        state: 'decode-error',
        source: facts.cached ? 'cache' : 'bundled',
      };
    const transport = TRANSPORT_FAILURES[failure];
    if (transport)
      return facts.cached
        ? { state: 'loaded-stale', source: 'cache' }
        : { state: transport, source: 'system-state' };
    if (failure === 'moved') return { state: 'moved', source: 'server' };
    return { state: failure as ScreenState, source: 'system-state' };
  }

  if (
    facts.fetch === 'in-flight' ||
    (facts.fetch === 'idle' && !facts.cached)
  ) {
    if (!facts.cached) return { state: 'loading-initial', source: 'skeleton' };
    return {
      state: facts.refreshing ? 'refreshing' : 'loaded-revalidating',
      source: 'cache',
    };
  }

  const source: UiSource = facts.fetch === 'ok' ? 'server' : 'cache';
  if (facts.projection === 'blocked')
    return { state: 'incompatible', source: 'earlier-release' };
  if (facts.pagination === 'loading') return { state: 'paginating', source };
  if (facts.pagination === 'failed')
    return { state: 'pagination-error', source };
  if (facts.dataEmpty) return { state: 'empty', source: 'authored-state' };
  if (facts.pagination === 'end') return { state: 'end-of-list', source };
  if (facts.projection === 'fallback') return { state: 'partial', source };
  return { state: 'loaded', source };
}

// --- node --------------------------------------------------------------------

export interface NodeFacts {
  /** What projection did with the node. */
  readonly outcome: NodeOutcome;
  readonly hidden?: 'flag' | 'visibility';
  /** The experiment arm this node is rendered as. */
  readonly variant?: string;
  /** A node fetched apart from its screen. */
  readonly deferred?: 'loading' | 'failed' | 'empty';
  /** A data-bound node's source. */
  readonly data?: 'loading' | 'failed' | 'stale';
  /** An action it needs is unsupported and set to disable. */
  readonly disabled?: boolean;
  readonly asset?: 'loading' | 'failed' | 'unsupported-format';
  /** A string fell back along the locale chain. */
  readonly stringMissing?: boolean;
  readonly truncated?: boolean;
}

/**
 * Every node state the facts amount to, most significant first. A node is often in several at
 * once — downgraded *and* waiting for an image — so this returns them all; the first is the one
 * that decides what is drawn.
 */
export function resolveNodeStates(facts: NodeFacts): NodeState[] {
  if (facts.hidden)
    return [
      facts.hidden === 'flag' ? 'hidden-by-flag' : 'hidden-by-visibility',
    ];
  if (facts.outcome === 'omitted') return ['omitted'];

  const states: NodeState[] = [];
  if (facts.deferred === 'loading') states.push('deferred-loading');
  if (facts.deferred === 'failed') states.push('deferred-error');
  if (facts.deferred === 'empty') states.push('deferred-empty');
  if (facts.data === 'loading') states.push('data-loading');
  if (facts.data === 'failed') states.push('data-error');
  if (facts.asset === 'unsupported-format')
    states.push('asset-format-unsupported');
  if (facts.asset === 'failed') states.push('asset-error');
  if (facts.asset === 'loading') states.push('asset-loading');
  if (facts.data === 'stale') states.push('data-stale');
  if (
    facts.outcome === 'fallback-authored' ||
    facts.outcome === 'fallback-catalog'
  )
    states.push(facts.outcome);
  if (facts.disabled) states.push('disabled');
  if (facts.stringMissing) states.push('string-missing');
  if (facts.truncated) states.push('truncated');
  if (facts.variant !== undefined) states.push('variant');
  if (
    facts.outcome === 'downgraded' ||
    facts.outcome === 'upgraded' ||
    facts.outcome === 'exact'
  )
    states.push(facts.outcome);
  return states;
}

// --- action and form ---------------------------------------------------------

export interface ActionFacts {
  /** Whether projection left the device an action it can run. */
  readonly supported: boolean;
  readonly phase: 'idle' | 'confirming' | 'pending' | 'succeeded' | 'failed';
  readonly failure?:
    | 'retryable'
    | 'terminal'
    | 'auth'
    | 'target-missing'
    | 'blocked-url'
    | 'validation'
    | 'rejected';
  /** Pending with no connection: held in the durable outbox, to be replayed in order. */
  readonly queued?: boolean;
  /** A form's draft was restored after the app was killed or its release changed. */
  readonly draftRestored?: boolean;
}

const ACTION_FAILURES: Record<
  NonNullable<ActionFacts['failure']>,
  ActionState
> = {
  retryable: 'failed-retryable',
  terminal: 'failed-terminal',
  auth: 'requires-auth',
  'target-missing': 'target-missing',
  'blocked-url': 'blocked-url',
  validation: 'invalid',
  rejected: 'server-rejected',
};

export function resolveActionState(facts: ActionFacts): ActionState {
  if (!facts.supported) return 'unsupported';
  if (facts.phase === 'failed')
    return ACTION_FAILURES[facts.failure ?? 'retryable'];
  if (facts.phase === 'pending')
    return facts.queued ? 'queued-offline' : 'pending';
  if (facts.phase === 'confirming') return 'confirming';
  if (facts.phase === 'succeeded') return 'succeeded';
  return facts.draftRestored ? 'draft-restored' : 'idle';
}
