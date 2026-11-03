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
  where: { or: { href_matches: { pathname: string }; relative_to: 'document' }[] };
  eagerness: 'moderate';
}

export interface SpeculationRules {
  prefetch?: SpeculationRule[];
  prerender?: SpeculationRule[];
}

/** The rule set for these manifests: every pierce pattern of a fragment that sets `speculate`. */
export function speculationRulesFor(manifests: readonly FragmentManifest[]): SpeculationRules {
  const rules: SpeculationRules = {};
  for (const action of ['prefetch', 'prerender'] as const) {
    const patterns = new Set<string>();
    for (const manifest of manifests) {
      if (manifest.speculate !== action) continue;
      for (const pattern of manifest.pierce ?? []) {
        patterns.add(pattern);
        const toggled = slashToggled(pattern);
        if (toggled) patterns.add(toggled);
      }
    }
    if (patterns.size === 0) continue;
    rules[action] = [
      {
        source: 'document',
        where: { or: [...patterns].map((pathname) => ({ href_matches: { pathname }, relative_to: 'document' })) },
        // on hover or pointerdown: early enough to feel instant, late enough not to fetch every link
        eagerness: 'moderate',
      },
    ];
  }
  return rules;
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
