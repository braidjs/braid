import { BraidError } from '../errors.js';
import { BRAID_PROTOCOL_VERSION } from '../protocol.js';
import { BoundaryChannel } from './channel.js';
import { WEAVE_VERSION } from './envelope.js';
import { ContextBridge, FragmentContract, HostContract } from './contract.js';

/**
 * The connect-time handshake: HELLO → ACCEPT → OPEN.
 *
 * Braid has always verified a version at boot — the gateway stamps `BRAID_PROTOCOL_VERSION` onto
 * the realm stub and the client checks the `<meta>`. That check answers "did these two ship
 * together?" and nothing else. It cannot answer the questions the phases above this one ask:
 * *which instance* am I talking to, *what* does it declare it can parse, and *when* did it become
 * ready to hear from me.
 *
 * Three steps rather than two, because ACCEPT and OPEN carry different things in different
 * directions and collapsing them would force the host to send the context snapshot before it has
 * seen what the fragment can parse — which is precisely the information that decides how the
 * snapshot must be projected.
 */

export const HELLO = 'weave/hello';
export const OPEN = 'weave/open';

/** Host → fragment. What the host is, and what it is prepared to speak. */
export interface HelloPayload {
  weave: number;
  /** The client ↔ gateway composition protocol version, echoed for diagnosis only. */
  protocol: string;
  fragmentId: string;
  instance: string;
  /** What the host offers, so a fragment can refuse from its own side too. */
  contract?: HostContract;
}

/** Fragment → host, as the reply to HELLO. What the fragment is, and what it can parse. */
export interface AcceptPayload {
  weave: number;
  /**
   * Per-key context contract versions this fragment speaks.
   *
   * A fragment built months ago reads a context published today, so it declares what it can parse
   * and every delivery is projected down to it. The registry manifest is the authority where it has
   * an opinion — see `resolveContextVersions` — because a compromised or merely stale fragment
   * should not be able to talk its way into a projection the host did not sanction.
   */
  contextVersions?: Record<string, number>;
  /**
   * What this fragment requires and provides.
   *
   * The registry manifest overrides it where it has an opinion, for the same reason it overrides
   * `contextVersions` — on the untrusted tier this half of the handshake is attacker-controlled,
   * and a fragment that could state its own requirements could state them away.
   */
  contract?: FragmentContract;
}

/** Host → fragment. The opening state, sent once terms are agreed. */
export interface OpenPayload {
  /** Every context key, already projected to this fragment's declared versions. */
  context: Record<string, unknown>;
  props: Record<string, unknown>;
}

/**
 * Ten seconds, and deliberately not the channel's default five.
 *
 * HELLO is the one request sent while the fragment is still booting — its realm may be parsing a
 * framework bundle on a cold cache over a slow connection. Every other request happens against a
 * fragment that has already proven it can answer, which is why they get a tighter deadline.
 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface HostHandshakeOptions {
  channel: BoundaryChannel;
  fragmentId: string;
  instance: string;
  /**
   * Context versions from the fragment's registry manifest, where the registry has an opinion.
   * Merged over whatever the fragment declares in ACCEPT.
   */
  manifestContextVersions?: Readonly<Record<string, number>>;
  /** What this host offers. Absent when the host declares no contract. */
  hostContract?: HostContract;
  /** The fragment's contract from its registry manifest, overriding what it declares in ACCEPT. */
  manifestContract?: FragmentContract;
  /**
   * Compares the two contracts. Injected so the handshake carries no contract logic of its own —
   * negotiation is a policy question and this module is a protocol.
   */
  negotiate?(host: HostContract | undefined, fragment: FragmentContract | undefined): {
    outcome: 'compatible' | 'bridged' | 'incompatible';
    bridges: ContextBridge[];
    reason?: string;
    fixHint?: string;
  };
  /** Reports a connection opened across a version gap, with what it costs. */
  onBridged?(bridges: ContextBridge[]): void;
  /** Builds the opening state once terms are agreed and versions are known to be reachable. */
  openWith(contextVersions: Readonly<Record<string, number>>): OpenPayload;
  /**
   * Raises if a declared version cannot be projected to from what the host publishes.
   *
   * Checked here, at the handshake, rather than at first delivery. That is where the context bus
   * already argues it belongs — "refusing the subscription makes it a start-up error with a
   * fragment's name on it" — and this moves it one step earlier still, to before the fragment has
   * been handed any state at all.
   */
  assertReachable(contextVersions: Readonly<Record<string, number>>): void;
  timeoutMs?: number;
}

export interface HandshakeResult {
  contextVersions: Readonly<Record<string, number>>;
  bridges: ContextBridge[];
}

/** Drives the host end. Resolves once the fragment has been sent its opening state. */
export async function performHostHandshake(options: HostHandshakeOptions): Promise<HandshakeResult> {
  const { channel, fragmentId, instance } = options;

  const hello: HelloPayload = {
    weave: WEAVE_VERSION,
    protocol: BRAID_PROTOCOL_VERSION,
    fragmentId,
    instance,
    ...(options.hostContract === undefined ? {} : { contract: options.hostContract }),
  };

  const accept = await channel.request<AcceptPayload>(HELLO, hello, {
    timeoutMs: options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS,
  });

  if (accept?.weave !== WEAVE_VERSION) {
    throw new BraidError(
      `the fragment answered with weave protocol v${String(accept?.weave)}, and this host speaks v${WEAVE_VERSION}`,
      {
        fragmentId,
        stage: 'handshake',
        fixHint: 'the host and the fragment are running different major versions of @braidlabs/core — align them',
      },
    );
  }

  /**
   * Terms before state.
   *
   * The negotiation runs between ACCEPT and OPEN because that is the only point where both halves
   * are known and nothing has crossed yet. A fragment refused here has been handed no context, no
   * props, and no reason to have started rendering.
   */
  const fragmentContract = options.manifestContract ?? accept.contract;
  const negotiation = options.negotiate?.(options.hostContract, fragmentContract) ?? {
    outcome: 'compatible' as const,
    bridges: [],
  };

  if (negotiation.outcome === 'incompatible') {
    throw new BraidError(negotiation.reason ?? 'the fragment’s contract is not compatible with this host', {
      fragmentId,
      stage: 'contract',
      ...(negotiation.fixHint === undefined ? {} : { fixHint: negotiation.fixHint }),
    });
  }

  if (negotiation.bridges.length > 0) options.onBridged?.(negotiation.bridges);

  const contextVersions = resolveContextVersions(accept.contextVersions, options.manifestContextVersions);
  options.assertReachable(contextVersions);

  // Fire and forget: OPEN carries state, not a question. Making it a request would mean the host
  // blocks its own mount on a fragment acknowledging state it has already been given, and a
  // fragment slow to acknowledge would look identical to one that never got it.
  channel.send(OPEN, options.openWith(contextVersions));

  return { contextVersions, bridges: negotiation.bridges };
}

export interface FragmentHandshakeOptions {
  channel: BoundaryChannel;
  /** What this fragment declares it can parse, per context key. */
  contextVersions?: Readonly<Record<string, number>>;
  /** What this fragment requires and provides. */
  contract?: FragmentContract;
  /** Called once the host sends the opening state. */
  onOpen(payload: OpenPayload): void;
}

/**
 * Answers the host end. Registers its handlers synchronously and returns a promise that resolves
 * at OPEN, so a caller may either await readiness or ignore it — the handlers are live either way,
 * which matters because HELLO can arrive in the same turn this is called.
 */
export function answerHandshake(options: FragmentHandshakeOptions): Promise<OpenPayload> {
  const { channel } = options;
  const { promise, resolve } = Promise.withResolvers<OpenPayload>();

  channel.on(HELLO, (): AcceptPayload => ({
    weave: WEAVE_VERSION,
    ...(options.contextVersions === undefined ? {} : { contextVersions: { ...options.contextVersions } }),
    ...(options.contract === undefined ? {} : { contract: options.contract }),
  }));

  channel.on(OPEN, (payload) => {
    const open = (payload ?? { context: {}, props: {} }) as OpenPayload;
    options.onOpen(open);
    resolve(open);
  });

  return promise;
}

/**
 * Merges the fragment's declaration with the registry's, with the registry winning.
 *
 * Not an arbitrary tie-break. The manifest is host-side configuration describing a fragment; the
 * ACCEPT payload is the fragment describing itself. On the untrusted tier the second of those is
 * attacker-controlled, and a fragment that could name its own context version could ask to be
 * served a shape the host never intended to project. Letting the registry win costs nothing when
 * the two agree, which is every honest case.
 */
export function resolveContextVersions(
  declared: Readonly<Record<string, number>> | undefined,
  fromManifest: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> {
  return { ...(declared ?? {}), ...(fromManifest ?? {}) };
}
