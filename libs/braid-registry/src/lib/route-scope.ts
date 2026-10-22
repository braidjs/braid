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
  if (canonical === '/' || /^\/[*:({]/.test(canonical)) return true;
  if (typeof URLPattern === 'undefined') return false;
  const compiled = new URLPattern({ pathname: canonical });
  return ['/__braid_probe', '/__braid_probe/deeper'].some((pathname) => compiled.test({ pathname }));
}

/** Whether a pattern stays under one of `prefixes` — `'/'` allows everything. */
export function withinPrefixes(pattern: string, prefixes: readonly string[]): boolean {
  if (prefixes.includes('/')) return true;
  const canonical = canonicalRoute(pattern);
  if (canonical === undefined) return false;
  return prefixes.some((prefix) => canonical === prefix || canonical.startsWith(`${prefix}/`));
}
