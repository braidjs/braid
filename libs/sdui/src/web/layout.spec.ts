import { describe, expect, it } from 'vitest';
import {
  COMPLEX_COST,
  RUN_COST,
  UNMEASURED_COST,
  layoutCost,
} from './layout.js';

describe('a text is priced by what laying it out costs', () => {
  it('Latin, Greek and Cyrillic text costs its length', () => {
    expect(layoutCost('hello, world')).toBe(12);
    expect(layoutCost('Grüße, café — naïve')).toBe(20); // upper-cased, ß is SS
    expect(layoutCost('привет')).toBe(6);
  });

  it('text in one complex script costs a few times its length, and no runs', () => {
    const hebrew = 'שלום עולם'; // 8 letters, a space
    expect(layoutCost(hebrew)).toBe(8 * COMPLEX_COST + 1);
    const japanese = 'こんにちは世界'; // kana and kanji: one run
    expect(layoutCost(japanese)).toBe(7 * COMPLEX_COST);
  });

  it('a sentence quoting a word in another script costs two runs', () => {
    expect(layoutCost('he said שלום and left')).toBe(
      17 + 4 * COMPLEX_COST + 2 * RUN_COST,
    );
  });

  it('alternating directions cost a run per change', () => {
    const text = 'aא'.repeat(10_000);
    expect(layoutCost(text)).toBe(
      10_000 * (1 + COMPLEX_COST) + (text.length - 1) * RUN_COST,
    );
  });

  it('rotating through scripts costs a run per character', () => {
    const scripts = 'अঅஅఅಅഅඅཀაԱሀᎠ한あ中ᠠꀀ';
    // kana and kanji share a font, so sixteen runs in seventeen characters
    const text = scripts.repeat(100);
    expect(layoutCost(text) / text.length).toBeGreaterThan(0.9 * RUN_COST);
  });

  it('bidi controls are runs of their own', () => {
    const [open, close] = [
      String.fromCharCode(0x202e),
      String.fromCharCode(0x202c),
    ];
    expect(layoutCost(`${open}a${close}`)).toBe(3 + 2 * RUN_COST);
  });

  it('a script broken into lines by dictionary, or not measured, costs the most per character', () => {
    const thai = 'สวัสดี';
    expect(layoutCost(thai)).toBe(thai.length * UNMEASURED_COST);
    const ethiopic = 'ሰላም';
    expect(layoutCost(ethiopic)).toBe(3 * UNMEASURED_COST);
  });

  it('an emoji family is one run of a few characters, joiners included', () => {
    const family = '👨‍👩‍👧';
    expect(layoutCost(family)).toBe(5 * COMPLEX_COST);
  });

  // from the seventh audit: characters a browser draws from fonts of their own
  it('symbols between letters are runs: a star, a watch, box drawing, maths, Braille', () => {
    for (const symbol of [0x2b50, 0x231a, 0x2500, 0x2200, 0x2801]) {
      const text = `a${String.fromCodePoint(symbol)}`.repeat(1_000);
      expect(layoutCost(text) / text.length).toBeGreaterThan(RUN_COST / 2);
    }
  });

  it('a run of one kind of symbol is one run', () => {
    expect(layoutCost('\u2500'.repeat(100))).toBe(100 * COMPLEX_COST);
  });

  it('C1 controls and emoji presentation selectors are runs', () => {
    expect(layoutCost(`a${String.fromCharCode(0x85)}`)).toBe(2 + RUN_COST);
    expect(layoutCost(`\u00a9${String.fromCharCode(0xfe0f)}`)).toBe(
      2 + RUN_COST,
    );
  });

  it('CJK punctuation between letters is a run; within CJK text it is not', () => {
    expect(layoutCost('a\u3001'.repeat(10))).toBeGreaterThan(19 * RUN_COST);
    expect(layoutCost('\u4e2d\u3001\u6587')).toBe(3 * COMPLEX_COST);
  });

  it('brackets in right-to-left text cost more; in left-to-right text they do not', () => {
    expect(layoutCost('(a)')).toBe(3);
    expect(layoutCost('\u05d0(((')).toBe(
      COMPLEX_COST + 3 + 3 * UNMEASURED_COST,
    );
  });

  it('unassigned code points are a run each, in any block', () => {
    expect(layoutCost('\u03b1\u0378'.repeat(10))).toBeGreaterThan(
      10 * RUN_COST,
    );
  });

  it('a text costs the dearest of its cases: CSS may upper-case it', () => {
    // ɐ is Latin, but its capital Ɐ is in a block of its own
    expect(layoutCost('a\u0250'.repeat(100))).toBeGreaterThan(100 * RUN_COST);
    expect(layoutCost('caf\u00e9')).toBe(4);
  });
});
