import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { findPierceOverlaps } from './analysis.js';
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

/** Segments drawn from a small set, so the two derived patterns often share literal text. */
const segment = fc.constantFrom('billing', 'checkout', 'pay', 'a', 'b', '123', '7', 'x-1', 'report.pdf', 'x-y');

/**
 * One way a pattern can match the segment `value`, as a piece that brings its own leading slash.
 * Every piece matches `/${value}` — the optional ones by being present, or by being absent where a
 * literal goes on without them.
 */
function derivePiece(value: string, choice: number, name: string): string {
  const split = Math.max(1, Math.floor(value.length / 2));
  switch (choice % 10) {
    case 0:
      return `/${value}`;
    case 1:
      return `/:${name}`;
    case 2:
      // a typed param, when the value is all digits or all letters; otherwise a literal
      if (/^\d+$/.test(value)) return `/:${name}(\\d+)`;
      if (/^[a-z]+$/.test(value)) return `/:${name}([a-z]+)`;
      return `/${value}`;
    case 3:
      return `/{${value}}`;
    case 4:
      // a literal split across a group, as in `/check{out}/:x`
      return value.length > 1 ? `/${value.slice(0, split)}{${value.slice(split)}}` : `/${value}`;
    case 5:
      return `/(${value.replace(/[^a-z0-9]/g, '.')})`;
    case 6:
      // an optional group or param, present
      return choice % 20 < 10 ? `{/${value}}?` : `/:${name}?`;
    case 7:
      // an optional param glued inside a literal and absent: `/report{/:id}?.pdf` matches `/report.pdf`
      return value.length > 1 ? `/${value.slice(0, split)}{/:${name}}?${value.slice(split)}` : `/${value}`;
    case 8:
      // a literal followed by an optional param that is absent here
      return `/${value}{/:${name}}?`;
    default:
      // an optional segment the path does not have, then this one
      return `{/zz}?/${value}`;
  }
}

/** A pattern that matches `segments`: piece by piece, or ending in a part that takes the rest. */
const derivedPattern = (segments: readonly string[]) =>
  fc
    .record({
      choices: fc.array(fc.nat(), { minLength: segments.length, maxLength: segments.length }),
      // where a part that matches every remaining segment takes over, if anywhere
      restAt: fc.option(fc.integer({ min: 0, max: segments.length - 1 }), { nil: undefined }),
      rest: fc.constantFrom('/*', '/:rest+', '/:rest*', '{/*}?'),
      // a group wrapping the leading slash too, `{/checkout}/pay`
      groupFirstSlash: fc.boolean(),
      // two segments under one regex: `/(a/b)`
      spanRegex: fc.boolean(),
      trailingSlash: fc.boolean(),
    })
    .map(({ choices, restAt, rest, groupFirstSlash, spanRegex, trailingSlash }) => {
      const kept = restAt === undefined ? segments : segments.slice(0, restAt);
      const pieces = kept.map((value, index) => derivePiece(value, choices[index]!, `p${index}`));
      if (spanRegex && kept.length >= 2 && /^[a-z0-9]+$/.test(kept[0]!) && /^[a-z0-9]+$/.test(kept[1]!)) {
        pieces.splice(0, 2, `/(${kept[0]}/${kept[1]})`);
      }
      if (groupFirstSlash && pieces[0] === `/${kept[0]}`) pieces[0] = `{/${kept[0]}}`;
      let pattern = pieces.join('');
      if (restAt !== undefined) pattern += rest;
      if (trailingSlash && restAt === undefined) pattern += '/';
      return pattern;
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

/** The soundness property, for any overlap decision. */
const soundness = (decide: (a: string, b: string) => boolean) =>
  fc.property(overlapCase, ({ path, a, b }) => {
    // Derivations are meant to match by construction; the guard keeps a bad derivation from
    // becoming a false failure instead of a skipped case.
    fc.pre(matches(a, path) && matches(b, path));
    expect(decide(a, b), `${a} and ${b} both match ${path}`).toBe(true);
  });

describe('routesMayOverlap, as a property', () => {
  it('never answers "disjoint" for two routes some path matches both of', () => {
    fc.assert(soundness(routesMayOverlap), { numRuns: 10_000 });
  });

  /**
   * A property that passes proves only as much as its generator reaches. These pin that it still
   * catches the two unsound decisions it has already caught, so a narrowed generator fails here
   * instead of passing quietly.
   */
  it('catches the sampled overlap the fragment pierce check uses (RG-1)', () => {
    const sampled = (a: string, b: string) =>
      findPierceOverlaps([
        { id: 'victim', endpoint: 'https://v.internal', pierce: [a] },
        { id: 'attacker', endpoint: 'https://a.internal', pierce: [b] },
      ]).length > 0;
    expect(fc.check(soundness(sampled), { numRuns: 10_000, seed: 1 }).failed).toBe(true);
  });

  it('catches a literal prefix that keeps a slash an optional part owns', () => {
    // routesMayOverlap's prefix rule before it learned this; `/report{/:id}?.pdf` beside `/report.:ext`
    const syntax = /[:*({?+\\]/;
    const naive = (a: string, b: string) => {
      const ca = new URLPattern({ pathname: a }).pathname;
      const cb = new URLPattern({ pathname: b }).pathname;
      if (!syntax.test(ca) || !syntax.test(cb)) return routesMayOverlap(a, b);
      const pa = ca.slice(0, ca.search(syntax));
      const pb = cb.slice(0, cb.search(syntax));
      return pa.startsWith(pb) || pb.startsWith(pa);
    };
    expect(fc.check(soundness(naive), { numRuns: 10_000, seed: 1 }).failed).toBe(true);
  });

  it('generates real overlaps, not mostly skipped cases', () => {
    // A generator whose cases mostly fail `fc.pre` would pass the property above by testing little.
    const sample = fc.sample(overlapCase, { numRuns: 2_000, seed: 42 });
    const real = sample.filter(({ path, a, b }) => matches(a, path) && matches(b, path)).length;
    expect(real / sample.length).toBeGreaterThan(0.9);
  });
});
