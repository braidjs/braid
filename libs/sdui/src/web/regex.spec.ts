import { describe, expect, it } from 'vitest';
import {
  RegexDialectError,
  a2uiRegexMatches,
  compileA2uiRegex,
} from './regex.js';

describe('the A2UI regex dialect', () => {
  it.each([
    // the spec's own accepted examples
    '^[a-z]+@[a-z]+\\.com$',
    '^(?=.*\\d).{8,}$',
    '\\w+\\s+\\w+',
    // and what the upstream examples use
    '^\\d{10}$',
    '^[0-9]{5}(-[0-9]{4})?$',
    '^(?!test).*$',
    '^\\u{1F600}?[A-Z]{2,3}$',
    'a{1,1000}b',
  ])('accepts %s', (pattern) => {
    expect(() => compileA2uiRegex(pattern)).not.toThrow();
  });

  it.each([
    ['(a+)+$', /unbounded repeat/], // rule 2
    ['(a|ab)*c', /start with the same character/], // rule 3
    ['\\d+\\s*\\d+', /adjacent/], // rule 4
    ['(\\w)\\1', /backreferences/],
    ['(?<=a)b', /lookbehind/],
    ['(?<year>\\d{4})', /named groups/],
    ['\\p{L}+', /\\p/],
    ['(?i)abc', /inline flags/],
    ['\\cA', /\\cX/],
    ['\\012', /octal/],
    ['(x+x+)+y', /unbounded repeat/],
    ['(.*a){3}', /unbounded repeat/],
    ['(\\d|\\w)+', /start with the same character/],
    ['.*.*=.*', /adjacent/],
    ['a'.repeat(257), /256 code points/],
    ['[z-a]', /out of order/],
    ['(abc', /expected/],
    ['abc)', /unmatched/],
  ])('refuses %s', (pattern, why) => {
    expect(() => compileA2uiRegex(pattern)).toThrow(RegexDialectError);
    expect(() => compileA2uiRegex(pattern)).toThrow(why);
  });

  it('matches with the dialect semantics: search, no multiline, a cap on the value', () => {
    const phone = compileA2uiRegex('^\\d{10}$');
    expect(a2uiRegexMatches(phone, '5551234567')).toBe(true);
    expect(a2uiRegexMatches(phone, '5551234567\n')).toBe(false);
    expect(a2uiRegexMatches(compileA2uiRegex('b'), 'abc')).toBe(true);
    expect(a2uiRegexMatches(compileA2uiRegex('a'), 'a'.repeat(4_097))).toBe(
      false,
    );
  });

  it('runs a refused-elsewhere shape quickly once accepted', () => {
    const start = performance.now();
    a2uiRegexMatches(
      compileA2uiRegex('^[a-z]+@[a-z]+\\.com$'),
      'a'.repeat(4_000) + '!',
    );
    expect(performance.now() - start).toBeLessThan(100);
  });
});
