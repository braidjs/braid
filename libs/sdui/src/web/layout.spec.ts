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
    expect(layoutCost('Grüße, café — naïve')).toBe(19);
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
});
