import { getBraidConfig } from '../config.js';
import { BraidError } from '../errors.js';

/**
 * Mount prerequisites: named things that must be ready before a fragment's code runs.
 *
 * The motivating case is auth. A fragment whose backend needs a session for its own authorization
 * server boots, calls its API, gets a 401, hops through a login, and retries — on every cold load.
 * The host usually knows how to warm that session (its own SSO client, a silent hop through the
 * fragment's login), so it registers a resolver per key and fragments declare the keys they need:
 *
 * ```ts
 * initBraid({ prerequisites: { 'session:*': (key, { signal }) => sessions.ensure(key.slice(8), { signal }) } });
 * ```
 * ```html
 * <fragment-slot name="kcd" requires="session:kcd"></fragment-slot>   <!-- or manifest `requires` -->
 * ```
 *
 * Braid knows a key and a promise, nothing about what either means. A key a slot declares in markup
 * starts resolving as the slot boots, alongside the realm and document fetches; one declared in the
 * manifest starts when the realm stub that carries it arrives. Either way the fragment's code waits
 * for it. Each key is resolved once at a time however many slots wait on it.
 */

/** What a resolver reports. `not-entitled` shows the slot's fallback instead of the fragment. */
export type PrerequisiteOutcome = 'ready' | 'not-entitled';

export type PrerequisiteResolver = (
  key: string,
  context: { signal: AbortSignal },
) => PrerequisiteOutcome | Promise<PrerequisiteOutcome>;

/** How long a resolver may take before the fragment fails with a `prerequisite` error. */
export const DEFAULT_PREREQUISITE_TIMEOUT_MS = 15_000;

/** A prerequisite outcome that is not a failure: the user may not see this fragment. */
export class NotEntitledError extends BraidError {
  readonly notEntitled = true;
}

/** Keys from a `requires` attribute (whitespace-separated) or a manifest list, cleaned. */
export function parseRequires(value: unknown): string[] {
  const keys = typeof value === 'string' ? value.split(/\s+/) : Array.isArray(value) ? value : [];
  return [...new Set(keys.filter((key): key is string => typeof key === 'string' && key !== ''))];
}

/** The resolver for a key: an exact entry, else the longest `prefix*` pattern that matches. */
function resolverFor(key: string): PrerequisiteResolver | undefined {
  const resolvers = getBraidConfig().prerequisites ?? {};
  if (Object.hasOwn(resolvers, key)) return resolvers[key];
  let best: { length: number; resolver: PrerequisiteResolver } | undefined;
  for (const [pattern, resolver] of Object.entries(resolvers)) {
    if (!pattern.endsWith('*')) continue;
    const prefix = pattern.slice(0, -1);
    if (key.startsWith(prefix) && (!best || prefix.length > best.length)) best = { length: prefix.length, resolver };
  }
  return best?.resolver;
}

interface InFlight {
  promise: Promise<PrerequisiteOutcome>;
  controller: AbortController;
  waiters: number;
}

/** One resolution per key at a time, shared by every slot waiting on it. */
const inFlight = new Map<string, InFlight>();

function shared(key: string, resolver: PrerequisiteResolver, timeoutMs: number): InFlight {
  let entry = inFlight.get(key);
  if (!entry) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    const promise = new Promise<PrerequisiteOutcome>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      Promise.resolve()
        .then(() => resolver(key, { signal }))
        .then(resolve, reject);
    }).finally(() => {
      if (inFlight.get(key) === entry) inFlight.delete(key);
    });
    entry = { promise, controller, waiters: 0 };
    inFlight.set(key, entry);
  }
  return entry;
}

/**
 * Waits for every key to be ready, for one fragment.
 *
 * Throws a {@link NotEntitledError} when any key reports `not-entitled`, and a `prerequisite`
 * BraidError for a key with no resolver, a resolver that throws, or one that outlasts the timeout.
 * Aborting `signal` stops waiting; the shared resolution is aborted once nobody waits on it.
 */
export async function awaitPrerequisites(keys: readonly string[], fragmentId: string, signal: AbortSignal): Promise<void> {
  const timeoutMs = getBraidConfig().prerequisiteTimeoutMs ?? DEFAULT_PREREQUISITE_TIMEOUT_MS;

  await Promise.all(
    keys.map(async (key) => {
      const resolver = resolverFor(key);
      if (!resolver) {
        throw new BraidError(`no prerequisite resolver handles "${key}"`, {
          fragmentId,
          stage: 'prerequisite',
          fixHint: `register one: initBraid({ prerequisites: { '${key}': (key, { signal }) => … } }), or a pattern like '${key.split(':')[0]}:*'`,
        });
      }

      const entry = shared(key, resolver, timeoutMs);
      entry.waiters++;
      const leave = () => {
        if (--entry.waiters === 0) entry.controller.abort(new DOMException('no fragment is waiting', 'AbortError'));
      };

      let outcome: PrerequisiteOutcome;
      try {
        outcome = await new Promise<PrerequisiteOutcome>((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          entry.promise.then(resolve, reject);
        });
      } catch (error) {
        if (signal.aborted) throw error;
        const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
        throw new BraidError(
          timedOut ? `the prerequisite "${key}" did not resolve within ${timeoutMs} ms` : `the prerequisite "${key}" failed`,
          { fragmentId, stage: 'prerequisite', cause: error, fixHint: `check the resolver registered for "${key}"` },
        );
      } finally {
        leave();
      }

      if (outcome === 'not-entitled') {
        throw new NotEntitledError(`not entitled to "${key}"`, {
          fragmentId,
          stage: 'prerequisite',
          fixHint: 'expected for a user without access: the slot shows its fallback',
        });
      }
      if (outcome !== 'ready') {
        throw new BraidError(`the prerequisite "${key}" resolved to ${JSON.stringify(outcome)}`, {
          fragmentId,
          stage: 'prerequisite',
          fixHint: "a resolver returns 'ready' or 'not-entitled'",
        });
      }
    }),
  );
}
