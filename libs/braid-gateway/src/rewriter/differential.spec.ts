import { describe, expect, it } from 'vitest';
import { hostileCases, random, REVIEW_CASES } from '../../testing/hostile-markup.js';
import { violations } from '../../testing/invariants.js';
import { prepareFragmentHtml as legacyPrepareFragmentHtml } from '../../testing/legacy-transforms.js';
import { prepareFragmentHtml } from './transforms.js';

/**
 * The rewriter against a parser: hostile fragments through `prepareFragmentHtml`, split at random,
 * then parsed by parse5 where a browser would parse them, with nothing live allowed to survive and
 * nothing allowed out of the element the fragment is placed in. parse5 implements `<select>` as
 * parsers did before customizable select; `e2e/rewriter-differential.e2e.ts` runs the same cases
 * through Chromium, which implements it after.
 */

function streamOf(html: string, splits: number[] = []): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const cuts = [...new Set(splits)].filter((cut) => cut > 0 && cut < html.length).sort((a, b) => a - b);
  const pieces = [0, ...cuts, html.length].slice(1).map((end, index, ends) => html.slice(index ? ends[index - 1] : 0, end));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
}

export const prepare = (html: string, splits?: number[]): Promise<string> =>
  new Response(prepareFragmentHtml(streamOf(html, splits), { fragmentId: 'f' })).text();

const legacyPrepare = (html: string): Promise<string> =>
  new Response(legacyPrepareFragmentHtml(streamOf(html), { fragmentId: 'f' })).text();

describe('the cases the review found', () => {
  for (const [name, markup] of Object.entries(REVIEW_CASES)) {
    it(name, async () => {
      const output = await prepare(markup);
      expect(violations(output), output).toEqual([]);
      // and at every split into two chunks, the same output
      for (let cut = 1; cut < markup.length; cut++) {
        expect(await prepare(markup, [cut]), `split at ${cut}`).toBe(output);
      }
    });
  }

  it('each was live through the old rewriter', async () => {
    const live: string[] = [];
    for (const [name, markup] of Object.entries(REVIEW_CASES)) {
      if (violations(await legacyPrepare(markup)).length) live.push(name);
    }
    expect(live).toEqual(Object.keys(REVIEW_CASES));
  });
});

describe('generated hostile fragments', () => {
  // BRAID_FUZZ_CASES and BRAID_FUZZ_SEED run a longer or different search than CI's
  const cases = hostileCases(Number(process.env.BRAID_FUZZ_CASES ?? 3000), Number(process.env.BRAID_FUZZ_SEED ?? 20261122));

  it('leave nothing live, and nothing out of place, however they are split', async () => {
    const next = random(7);
    const failures: string[] = [];
    for (const [index, markup] of cases.entries()) {
      const whole = await prepare(markup);
      const found = violations(whole);
      if (found.length) failures.push(`#${index} ${JSON.stringify(markup)}\n  -> ${JSON.stringify(whole)}\n  ${found.join('\n  ')}`);
      const splits = Array.from({ length: 1 + Math.floor(next() * 5) }, () => Math.floor(next() * markup.length));
      const split = await prepare(markup, splits);
      if (split !== whole) failures.push(`#${index} differs when split at ${splits}: ${JSON.stringify(markup)}`);
      if (failures.length >= 10) break;
    }
    expect(failures.join('\n\n')).toBe('');
  }, 1_200_000);

  it('would mostly have been live through the old rewriter: the generator finds what it is for', async () => {
    let live = 0;
    for (const markup of cases.slice(0, 500)) if (violations(await legacyPrepare(markup)).length) live++;
    expect(live).toBeGreaterThan(150);
  }, 60_000);
});
