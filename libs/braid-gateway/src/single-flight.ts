/**
 * Collapses concurrent identical fragment fetches into one.
 *
 * **Not a cache, and the distinction is the whole design.** A cache answers from the past and has
 * to reason about staleness, invalidation, and — on ECS or any multi-instance deployment — which
 * instance holds the entry. This holds nothing: it only notices that a fetch it is *already making*
 * is the one a second request wants, and lets both use the result. Nothing outlives the request
 * that started it, so there is no TTL to tune, no invalidation to get wrong, and instance affinity
 * is irrelevant.
 *
 * That is why this belongs in the gateway while response caching belongs in a CDN. A CDN in front
 * of the gateway caches the composed document beautifully and does nothing at all for the N origin
 * fetches a cache *miss* still costs. An unbound widget pierced into `/` and `/*` is fetched once
 * per page render; fifty concurrent renders are fifty fetches of identical content. This makes them
 * one.
 */

export interface SingleFlight {
  /**
   * Runs `fetcher`, or joins the identical call already in progress.
   *
   * Every participant receives its own `Response` — bodies are single-use, so joiners cannot be
   * handed the same object.
   */
  run(key: string, fetcher: () => Promise<Response>): Promise<Response>;
  /** In-flight entries. For tests and for a health endpoint that wants to show the collapse rate. */
  size(): number;
}

export function createSingleFlight(): SingleFlight {
  const inflight = new Map<string, Promise<Response>>();

  return {
    async run(key, fetcher) {
      const existing = inflight.get(key);
      if (existing) return (await existing).clone();

      const flight = fetcher();
      inflight.set(key, flight);

      let response: Response;
      try {
        response = await flight;
      } finally {
        // Removed as soon as it settles: a request arriving after this point must start its own
        // fetch rather than join a completed one, which is what keeps this a coalescer and not a
        // cache with an accidental TTL.
        inflight.delete(key);
      }

      const mine = response.clone();

      /**
       * Release the branch nobody reads.
       *
       * Every participant — including this one — takes a clone, so the original is left unread.
       * `clone()` tees the body, and a tee buffers without bound for whichever branch lags, so an
       * abandoned original would hold the whole response in memory. Cancelling it stops that.
       *
       * On a macrotask rather than a microtask because the joiners' `await` continuations are
       * microtasks: cancelling sooner would race them and destroy the body they are about to
       * clone. Cancelling one tee branch does not disturb the others.
       */
      setTimeout(() => void response.body?.cancel().catch(() => undefined), 0);

      return mine;
    },

    size: () => inflight.size,
  };
}

/**
 * The key two requests must agree on before their fetches may be shared.
 *
 * **This is a correctness boundary, not an optimization knob.** Two requests get one response, so
 * anything that could make the endpoint answer differently has to be in the key — otherwise one
 * user is served a render personalized for another, which is a data leak wearing a performance
 * feature's clothes.
 *
 * So `cookie` and `authorization` are included verbatim. The honest consequence is that
 * coalescing helps anonymous and shared-identity traffic a great deal and personalized fragments
 * not at all: two signed-in users have different cookies and therefore never share a flight. That
 * is the correct behaviour, not a limitation to tune away.
 *
 * `user-agent` is in the key for the same reason, and it is the one that matters now that this is
 * on by default: server-side device detection is common and completely invisible from the
 * manifest, so an endpoint rendering a mobile layout would otherwise have it served to the next
 * desktop request that happened to arrive alongside it. It costs collapse rate — user-agent
 * strings are diverse — and that is the right trade for a default.
 *
 * What this cannot see is an endpoint varying on something unusual: a tenant header, a
 * feature-flag header, anything bespoke. Those set `coalesce: false` on the manifest.
 *
 * `extraHeaders` closes that gap for headers the *gateway itself* adds per request — an identity
 * assertion from a function-form `additionalHeaders`, most importantly. Those vary by caller and
 * are invisible to everything above, so leaving them out of the key would hand one caller a
 * fragment rendered for another. Names, not values: the values are read off the request that is
 * actually being sent.
 *
 * Returns null when the request must not be shared at all.
 */
export function singleFlightKey(
  request: Request,
  url: string,
  extraHeaders: readonly string[] = [],
): string | null {
  // Only safe methods. A POST is an action, and two identical actions are still two actions.
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;

  // A range request is a slice of a body; sharing one response across different ranges would hand
  // callers bytes they did not ask for.
  if (request.headers.has('range')) return null;

  return [
    request.method,
    url,
    request.headers.get('cookie') ?? '',
    request.headers.get('authorization') ?? '',
    // Content negotiation the endpoint may legitimately vary on.
    request.headers.get('accept-language') ?? '',
    request.headers.get('accept') ?? '',
    request.headers.get('user-agent') ?? '',
    // Sorted, so the key does not depend on the order a host happened to build its object in.
    ...[...extraHeaders].sort().map((name) => `${name}=${request.headers.get(name) ?? ''}`),
  ].join('\n');
}
