/**
 * A per-fragment circuit breaker.
 *
 * **The problem it solves is compounding, not failure.** A fragment endpoint that is down already
 * costs its full `timeoutMs` — but it costs that on *every* request, because nothing remembers the
 * last one. Four fragments at a 3s budget means a page held hostage to the worst of them, over and
 * over, with the shell's own response waiting behind it. The fallback machinery already handles a
 * fragment that fails; what it cannot do is stop paying to rediscover that it fails.
 *
 * So the breaker's job is to convert a slow, repeated failure into a fast, cheap one. It is a
 * latency control first and an availability control second.
 *
 * Deliberately per fragment id, never global: fragments are independently deployed, and one team's
 * bad release must not open a circuit in front of another team's healthy app.
 */

export interface BreakerOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** How long it stays open before a single probe is allowed through, in ms. */
  resetTimeoutMs: number;
}

export const DEFAULT_BREAKER: BreakerOptions = {
  // Three, not one: a single failure is noise — a deploy rolling, a pod cycling, a dropped
  // connection. Opening on the first one would make the breaker itself the outage.
  failureThreshold: 3,
  resetTimeoutMs: 10_000,
};

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerTransition {
  fragmentId: string;
  from: BreakerState;
  to: BreakerState;
  /** Consecutive failures at the moment of the transition. */
  failures: number;
}

interface Circuit {
  state: BreakerState;
  failures: number;
  openedAt: number;
  /** True while a half-open probe is in flight, so only one request pays to test recovery. */
  probing: boolean;
}

export interface Breaker {
  /**
   * Whether a request may proceed.
   *
   * Calling this *claims* the half-open probe when it returns true in that state, so a caller
   * that asks must go on to report the outcome — otherwise recovery stalls behind a probe that
   * never resolves.
   */
  allows(fragmentId: string): boolean;
  succeeded(fragmentId: string): void;
  failed(fragmentId: string): void;
  stateOf(fragmentId: string): BreakerState;
  /** Drops a fragment's circuit — after a registry refresh removed it or changed its endpoint. */
  forget(fragmentId: string): void;
}

/**
 * Creates a breaker.
 *
 * `onTransition` fires only on genuine state changes, never per request — a hook that fired on
 * every call would be a metrics firehose describing nothing, and the interesting events here are
 * exactly the four edges between states.
 */
export function createBreaker(
  options: Partial<BreakerOptions> = {},
  onTransition?: (transition: BreakerTransition) => void,
  now: () => number = Date.now,
): Breaker {
  const { failureThreshold, resetTimeoutMs } = { ...DEFAULT_BREAKER, ...options };
  const circuits = new Map<string, Circuit>();

  const circuitFor = (fragmentId: string): Circuit => {
    let circuit = circuits.get(fragmentId);
    if (!circuit) {
      circuit = { state: 'closed', failures: 0, openedAt: 0, probing: false };
      circuits.set(fragmentId, circuit);
    }
    return circuit;
  };

  const transition = (fragmentId: string, circuit: Circuit, to: BreakerState): void => {
    if (circuit.state === to) return;
    const from = circuit.state;
    circuit.state = to;
    onTransition?.({ fragmentId, from, to, failures: circuit.failures });
  };

  return {
    allows(fragmentId) {
      const circuit = circuitFor(fragmentId);

      if (circuit.state === 'closed') return true;

      if (circuit.state === 'open') {
        if (now() - circuit.openedAt < resetTimeoutMs) return false;
        // The cooldown has elapsed: promote to half-open and let exactly this caller probe.
        transition(fragmentId, circuit, 'half-open');
        circuit.probing = true;
        return true;
      }

      // half-open: one probe at a time. Everything else is still shed, because a recovering
      // endpoint hit with the full load that took it down is an endpoint that goes down again.
      if (circuit.probing) return false;
      circuit.probing = true;
      return true;
    },

    forget(fragmentId) {
      circuits.delete(fragmentId);
    },

    succeeded(fragmentId) {
      const circuit = circuitFor(fragmentId);
      circuit.failures = 0;
      circuit.probing = false;
      transition(fragmentId, circuit, 'closed');
    },

    failed(fragmentId) {
      const circuit = circuitFor(fragmentId);
      circuit.failures += 1;
      circuit.probing = false;

      // A failed probe re-opens immediately and restarts the cooldown, rather than counting
      // toward the threshold again — the endpoint has already proved it is still broken.
      if (circuit.state === 'half-open' || circuit.failures >= failureThreshold) {
        circuit.openedAt = now();
        transition(fragmentId, circuit, 'open');
      }
    },

    stateOf(fragmentId) {
      const circuit = circuits.get(fragmentId);
      if (!circuit) return 'closed';
      // Report the state a caller would actually get, so an operator reading this does not see
      // `open` for a circuit whose cooldown lapsed minutes ago and which is really ready to probe.
      if (circuit.state === 'open' && now() - circuit.openedAt >= resetTimeoutMs) return 'half-open';
      return circuit.state;
    },
  };
}
