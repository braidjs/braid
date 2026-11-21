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

describe('matching without backtracking', () => {
  // Patterns the reviews found the static rules let through. Each one froze a page with a
  // backtracking engine; matched here, each is a few milliseconds whatever the value.
  it.each([
    ['^(?:a|a){0,999}$', 'a'.repeat(28) + '!'],
    ['^(?:a{0,999}){0,999}$', 'a'.repeat(24) + '!'],
    ['^a{0,999}a{0,999}a{0,999}a{0,999}!', 'a'.repeat(300)],
    ['^(?:b?a*)(?:b?a*)(?:b?a*)(?:b?a*)(?:b?a*)!', 'a'.repeat(200)],
    ['(a|b?){20}c', 'a'.repeat(20)],
    ['^(?:a?){22}$', 'a'.repeat(22) + 'b'],
    [
      '^(a?){25}a{25}$',
      'a'.repeat(28) + '0'.repeat(28) + ' '.repeat(20) + 'x'.repeat(28),
    ],
  ])('%s against a hostile value is fast', (pattern, value) => {
    let regex;
    try {
      regex = compileA2uiRegex(pattern);
    } catch (error) {
      expect(error).toBeInstanceOf(RegexDialectError); // refused outright is fine too
      return;
    }
    const start = performance.now();
    let threw = false;
    try {
      a2uiRegexMatches(regex, value);
      a2uiRegexMatches(regex, value.repeat(10).slice(0, 4_000));
    } catch (error) {
      expect(error).toBeInstanceOf(RegexDialectError); // the step budget, not a freeze
      threw = true;
    }
    expect(performance.now() - start).toBeLessThan(1_500);
    void threw;
  });

  it('refuses a counted repeat above 1000', () => {
    expect(() => compileA2uiRegex('a{0,99999}')).toThrow(/above 1000/);
  });

  it.each([
    ['^[a-z]+@[a-z]+\\.com$', 'ada@example.com', true],
    ['^[a-z]+@[a-z]+\\.com$', 'ada@example.org', false],
    ['^(?=.*\\d).{8,}$', 'password1', true],
    ['^(?=.*\\d).{8,}$', 'password', false],
    ['^(?!test)\\w+$', 'testing', false],
    ['^(?!test)\\w+$', 'tasting', true],
    ['\\bcat\\b', 'a cat sat', true],
    ['\\bcat\\b', 'concatenate', false],
    ['\\Bcat\\B', 'concatenate', true],
    ['^\\d{3}-\\d{4}$', '555-1234', true],
    ['^\\d{3}-\\d{4}$', '555-12345', false],
    ['colou?r', 'my color', true],
    ['^(ab|cd){2,3}$', 'abcdab', true],
    ['^(ab|cd){2,3}$', 'ab', false],
    ['^\\u{1F600}$', '😀', true],
    ['^.$', '😀', true],
    ['^.$', '\n', false],
    ['a$', 'a\n', false],
    ['^[^\\d\\s]+$', 'abc', true],
    ['^[^\\d\\s]+$', 'a c', false],
  ])('%s on %j is %s, as ECMAScript says', (pattern, value, expected) => {
    expect(a2uiRegexMatches(compileA2uiRegex(pattern), value)).toBe(expected);
    expect(new RegExp(pattern, 'u').test(value)).toBe(expected);
  });
});

describe('the matcher agrees with ECMAScript', () => {
  it('on 3000 random patterns and values', () => {
    let seed = 0x9e3779b9;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    const pick = <T>(list: readonly T[]): T =>
      list[Math.floor(random() * list.length)] as T;
    const atom = (depth: number): string => {
      const r = random();
      if (depth < 2 && r < 0.15) return `(${alt(depth + 1)})`;
      if (depth < 2 && r < 0.22) return `(?:${alt(depth + 1)})`;
      if (depth < 2 && r < 0.26)
        return `(?${pick(['=', '!'])}${alt(depth + 1)})`;
      return pick([
        'a',
        'b',
        'c',
        '.',
        '[ab]',
        '[^a]',
        '\\d',
        '\\w',
        '\\s',
        '\\b',
        '^',
        '$',
        '\\.',
      ]);
    };
    const quant = (): string =>
      pick(['', '', '', '*', '+', '?', '{2}', '{1,3}', '{0,2}', '*?', '+?']);
    const seq = (depth: number): string =>
      Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
        const a = atom(depth);
        return /^[\^$]|^\\b/.test(a) ||
          a.startsWith('(?=') ||
          a.startsWith('(?!')
          ? a
          : a + quant();
      }).join('');
    const alt = (depth: number): string =>
      Array.from({ length: 1 + Math.floor(random() * 2) }, () =>
        seq(depth),
      ).join('|');
    let compared = 0;
    for (let i = 0; i < 3_000; i++) {
      const pattern = alt(0);
      let regex;
      try {
        regex = compileA2uiRegex(pattern);
      } catch {
        continue; // refused by the dialect or its safety rules
      }
      const native = new RegExp(pattern, 'u');
      for (let j = 0; j < 4; j++) {
        const value = Array.from({ length: Math.floor(random() * 8) }, () =>
          pick(['a', 'b', 'c', '1', ' ', '.', '\n']),
        ).join('');
        expect(
          a2uiRegexMatches(regex, value),
          `${pattern} on ${JSON.stringify(value)}`,
        ).toBe(native.test(value));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(4_000);
  });
});
