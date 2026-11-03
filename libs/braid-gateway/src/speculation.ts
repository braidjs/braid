import type { FragmentManifest } from './registry.js';

/**
 * Speculation Rules (Chromium) built from the registry: the pages a fragment pierces, for the
 * fragments that asked the browser to fetch or render them before a click.
 *
 * Nothing here is stored or configured beyond the manifests. The gateway already knows which URL
 * patterns compose which fragment; the browser is told the same patterns, in the format it reads.
 */

export interface SpeculationRule {
  source: 'document';
  where: {
    and: [
      { or: { href_matches: { pathname: string }; relative_to: 'document' }[] },
      { not: { selector_matches: string } },
    ];
  };
  eagerness: 'moderate';
}

/**
 * Links never speculated, whatever they point at: ones the page marks as not to be followed (as
 * user-generated content often is), and ones it opts out by name.
 */
export const SPECULATION_EXCLUDED_LINKS = '[rel~="nofollow"], [data-braid-no-speculate]';

export interface SpeculationRules {
  prefetch?: SpeculationRule[];
  prerender?: SpeculationRule[];
}

/**
 * The rule set for these manifests: every pierce pattern of a bound fragment that sets
 * `speculate`.
 *
 * Two kinds are left out, because their patterns describe pages the fragment does not own:
 *
 * - **An unbound fragment** is chrome — a header, a notifications panel — pierced into pages
 *   that belong to someone else.
 * - **A pattern that matches any path** (`/*`, `/:rest*`) would make every same-origin link on
 *   every page speculative, `/logout` included.
 */
export function speculationRulesFor(manifests: readonly FragmentManifest[]): SpeculationRules {
  const rules: SpeculationRules = {};
  for (const action of ['prefetch', 'prerender'] as const) {
    const patterns = new Set<string>();
    for (const manifest of manifests) {
      if (manifest.speculate !== action || manifest.bound === false) continue;
      for (const pattern of manifest.pierce ?? []) {
        if (matchesAnyPath(pattern)) continue;
        patterns.add(pattern);
        const toggled = slashToggled(pattern);
        if (toggled) patterns.add(toggled);
      }
    }
    if (patterns.size === 0) continue;
    rules[action] = [
      {
        source: 'document',
        where: {
          and: [
            { or: [...patterns].map((pathname) => ({ href_matches: { pathname }, relative_to: 'document' })) },
            { not: { selector_matches: SPECULATION_EXCLUDED_LINKS } },
          ],
        },
        // on hover or pointerdown: early enough to feel instant, late enough not to fetch every link
        eagerness: 'moderate',
      },
    ];
  }
  return rules;
}

/**
 * Whether a pierce pattern covers every page of the site rather than some of them: anything that
 * is not a literal first segment (`/*`, `/:page`, `/(.*)`), or that matches a path nobody wrote.
 * The home page alone (`/`) is a page like any other. Registry analysis judges it the same way.
 */
export function matchesAnyPath(pattern: string): boolean {
  if (pattern === '/') return false;
  if (!/^\/[^:*({?+\\]/.test(pattern)) return true;
  try {
    const compiled = new URLPattern({ pathname: pattern });
    return ['/__braid_probe', '/__braid_probe/deeper'].some((pathname) => compiled.test({ pathname }));
  } catch {
    return true;
  }
}

/**
 * The pattern that matches the trailing-slash twin of a URL this one matches.
 *
 * Pierce matching is slash-insensitive (`/checkout/*` also pierces `/checkout`), and a link the
 * gateway would compose should be speculated too. URLPattern itself is strict, so the twin is
 * listed alongside.
 */
function slashToggled(pattern: string): string | null {
  if (pattern === '/' || pattern === '/*') return null;
  if (pattern.endsWith('/*')) return pattern.slice(0, -2);
  if (pattern.endsWith('*')) return null;
  return pattern.endsWith('/') ? pattern.slice(0, -1) : `${pattern}/`;
}
