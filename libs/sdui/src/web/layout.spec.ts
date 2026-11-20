import { describe, expect, it } from 'vitest';
import { DICTIONARY_COST, RUN_COST, layoutCost } from './layout.js';

describe('a text is priced by what laying it out costs', () => {
  it('plain text, and ordinary text in one script, costs its length', () => {
    expect(layoutCost('hello, world')).toBe(12);
    expect(layoutCost('שלום עולם')).toBe(9);
    expect(layoutCost('مرحبا بك')).toBe(8);
    expect(layoutCost('Grüße, café — naïve')).toBe(19);
    // one change into Hebrew and one back: a sentence quoting a word costs two runs
    expect(layoutCost('he said שלום and left')).toBe(21 + 2 * RUN_COST);
  });

  it('alternating directions cost a run per change', () => {
    const text = 'aא'.repeat(10_000);
    expect(layoutCost(text)).toBe(text.length + (text.length - 1) * RUN_COST);
  });

  it('bidi controls are runs of their own', () => {
    expect(layoutCost('‮a‬')).toBe(3 + 2 * RUN_COST);
    expect(layoutCost('‏'.repeat(10))).toBe(10 + 10 * RUN_COST);
  });

  it('scripts broken into lines by dictionary cost more per character', () => {
    const thai = 'สวัสดี';
    expect(layoutCost(thai)).toBe(thai.length * (1 + DICTIONARY_COST));
  });

  it('marks and punctuation start no run', () => {
    expect(layoutCost('éé — “q” …')).toBe(12);
  });

  it('20,000 alternating characters cost what 20 million plain ones do', () => {
    expect(layoutCost('aא'.repeat(10_000))).toBeGreaterThan(19_000_000);
  });
});
