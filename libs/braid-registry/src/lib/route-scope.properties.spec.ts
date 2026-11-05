import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { routesMayOverlap } from './route-scope.js';

/**
 * Soundness of `routesMayOverlap`, as a property rather than a list of cases.
 *
 * Ownership checks refuse a route when it may overlap another team's. A false positive costs a
 * refused publish; a false negative hands someone else's pages to the caller. So the property is
 * one-sided: whenever some path matches both patterns, the answer must be "may overlap".
 *
 * Every case is built from a concrete path, and both patterns are derived from it, so each is a
 * real overlap by construction — the generator spends its runs on the direction that matters,
 * instead of mostly producing disjoint pairs. The derivations are the pattern shapes the check has
 * already been fooled by elsewhere: `{…}` groups (RG-1), typed params, and a trailing `*`.
 */

/** Segments drawn from a small set, so derivations from different paths still collide often. */
const segment = fc.constantFrom('billing', 'checkout', 'pay', 'a', 'b', '123', '7', 'x-1');

/** One way a pattern can match the segment `value`. */
function deriveSegment(value: string, choice: number, name: string): string {
  switch (choice % 6) {
    case 0:
      return value;
    case 1:
      return `:${name}`;
    case 2:
      // a typed param, when the value is all digits or all letters; otherwise a literal
      if (/^\d+$/.test(value)) return `:${name}(\\d+)`;
      if (/^[a-z]+$/.test(value)) return `:${name}([a-z]+)`;
      return value;
    case 3:
      return `{${value}}`;
    case 4:
      // a literal split across a group, as in `/check{out}/:x`
      return value.length > 1 ? `${value.slice(0, 1)}{${value.slice(1)}}` : value;
    default:
      return `(${value.replace(/[^a-z0-9]/g, '.')})`;
  }
}

/** A pattern that matches `segments`, or a prefix of them followed by `*`. */
const derivedPattern = (segments: readonly string[]) =>
  fc
    .record({
      choices: fc.array(fc.nat(), { minLength: segments.length, maxLength: segments.length }),
      // where a trailing `*` takes over, if anywhere
      starAt: fc.option(fc.integer({ min: 0, max: segments.length - 1 }), { nil: undefined }),
      // a group wrapping the leading slash too, `{/checkout}/pay`
      groupFirstSlash: fc.boolean(),
      trailingSlash: fc.boolean(),
    })
    .map(({ choices, starAt, groupFirstSlash, trailingSlash }) => {
      const kept = starAt === undefined ? segments : segments.slice(0, starAt);
      const parts = kept.map((value, index) => deriveSegment(value, choices[index]!, `p${index}`));
      let pattern = parts.map((part) => `/${part}`).join('');
      if (groupFirstSlash && kept.length > 0 && parts[0] === kept[0]) {
        pattern = `{/${kept[0]}}${pattern.slice(1 + kept[0]!.length)}`;
      }
      if (starAt !== undefined) pattern += '/*';
      if (trailingSlash && starAt === undefined) pattern += '/';
      return pattern || '/*';
    });

const overlapCase = fc
  .array(segment, { minLength: 1, maxLength: 4 })
  .chain((segments) =>
    fc.record({
      path: fc.constant(`/${segments.join('/')}`),
      a: derivedPattern(segments),
      b: derivedPattern(segments),
    }),
  );

/** As the gateway pierces: a pattern answers a path with or without its trailing slash. */
function matches(pattern: string, path: string): boolean {
  let matcher: URLPattern;
  try {
    matcher = new URLPattern({ pathname: pattern });
  } catch {
    return false;
  }
  return [path, `${path}/`].some((pathname) => matcher.test({ pathname }));
}

describe('routesMayOverlap, as a property', () => {
  it('never answers "disjoint" for two routes some path matches both of', () => {
    fc.assert(
      fc.property(overlapCase, ({ path, a, b }) => {
        // Derivations are meant to match by construction; the guard keeps a bad derivation from
        // becoming a false failure instead of a skipped case.
        fc.pre(matches(a, path) && matches(b, path));
        expect(routesMayOverlap(a, b), `${a} and ${b} both match ${path}`).toBe(true);
      }),
      { numRuns: 10_000 },
    );
  });

  it('generates real overlaps, not mostly skipped cases', () => {
    // A generator whose cases mostly fail `fc.pre` would pass the property above by testing little.
    const sample = fc.sample(overlapCase, { numRuns: 2_000, seed: 42 });
    const real = sample.filter(({ path, a, b }) => matches(a, path) && matches(b, path)).length;
    expect(real / sample.length).toBeGreaterThan(0.9);
  });
});
