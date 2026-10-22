/**
 * Whether a route pattern stays inside the part of a site it is allowed to claim.
 *
 * Judged on the pattern as URLPattern reads it, not as written. URLPattern resolves dot segments
 * in every spelling — `/billing/../login`, `/billing/%2e%2e/login`, `/billing{/..}/login` all
 * compile to `/login` — so a string prefix test on the written pattern is a test of nothing.
 */

/** The pattern with dot segments resolved, or undefined when it does not compile. */
export function canonicalRoute(pattern: string): string | undefined {
  if (typeof URLPattern === 'undefined') {
    // Without URLPattern nothing is resolved for us, so refuse anything that could be resolved.
    return /\.|%2e|[{}\\]/i.test(pattern) ? undefined : pattern;
  }
  try {
    return new URLPattern({ pathname: pattern }).pathname;
  } catch {
    return undefined;
  }
}

/**
 * Whether a pattern claims every page of the site: `/`, or anything that matches an arbitrary
 * top-level path — `/*`, `/:page`, `/(.*)`, `/{*}`. A pattern that does not compile counts, so an
 * unreadable claim is refused rather than waved through.
 */
export function claimsWholeSite(pattern: string): boolean {
  const canonical = canonicalRoute(pattern);
  if (canonical === undefined) return true;
  // Anything but a literal first character is a pattern over the first segment — `/*`, `/:page`,
  // or one that does not even start with a slash, like `(/[^_].*)` — and is judged a whole-site
  // claim outright. Probing can only show what a pattern matches, never that it matches no more.
  if (canonical === '/' || !/^\/[^:*({?+\\]/.test(canonical)) return true;
  if (typeof URLPattern === 'undefined') return false;
  const compiled = new URLPattern({ pathname: canonical });
  return ['/__braid_probe', '/__braid_probe/deeper'].some((pathname) => compiled.test({ pathname }));
}

/** Whether a pattern stays under one of `prefixes` — `'/'` allows everything. */
export function withinPrefixes(pattern: string, prefixes: readonly string[]): boolean {
  if (prefixes.includes('/')) return true;
  const canonical = canonicalRoute(pattern);
  if (canonical === undefined) return false;
  // Prefixes are read the same way, so `/café` compares as the `/caf%C3%A9` URLPattern produces.
  return prefixes
    .map((prefix) => canonicalRoute(prefix) ?? prefix)
    .some((prefix) => canonical === prefix || canonical.startsWith(`${prefix}/`));
}

/** Characters that make the rest of a pattern a pattern rather than literal text. */
const PATTERN_SYNTAX = /[:*({?+\\]/;

/**
 * Whether two route patterns could answer the same request, allowing for the trailing-slash
 * tolerance the gateway applies — judged conservatively, for refusing a claim.
 *
 * Two patterns cannot be compared exactly by sampling: each can miss the other's sample while both
 * match a real path (`/billing/*` and `/bill{ing}/:x(\\d+)` both match `/billing/123`). So:
 *
 * - two literal routes overlap when they are the same path, ignoring a trailing slash;
 * - a literal and a pattern overlap when the pattern matches the literal, with or without the slash;
 * - two patterns are presumed to overlap when one's literal prefix is a prefix of the other's.
 *
 * The last can refuse routes that are in fact disjoint — `/billing/:id(\\d+)` beside
 * `/billing/:slug([a-z]+)` — which is the right way to be wrong when the cost of the other way is
 * someone else's pages. A pattern that does not compile overlaps everything.
 */
export function routesMayOverlap(a: string, b: string): boolean {
  const ca = canonicalRoute(a);
  const cb = canonicalRoute(b);
  if (ca === undefined || cb === undefined) return true;
  const literalA = !PATTERN_SYNTAX.test(ca);
  const literalB = !PATTERN_SYNTAX.test(cb);
  const trim = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

  if (literalA && literalB) return trim(ca) === trim(cb);
  if (literalA || literalB) {
    if (typeof URLPattern === 'undefined') return true;
    const [literal, pattern] = literalA ? [trim(ca), cb] : [trim(cb), ca];
    const matcher = new URLPattern({ pathname: pattern });
    return [literal, literal === '/' ? '/' : `${literal}/`].some((pathname) => matcher.test({ pathname }));
  }
  const prefixA = ca.slice(0, ca.search(PATTERN_SYNTAX));
  const prefixB = cb.slice(0, cb.search(PATTERN_SYNTAX));
  return prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA);
}
