import { type DefaultTreeAdapterTypes, parse, serialize } from 'parse5';
import { describe, expect, it } from 'vitest';
import { prepareFragmentHtml as legacyPrepareFragmentHtml } from '../../testing/legacy-transforms.js';
import { wellFormedPages } from '../../testing/well-formed-markup.js';
import { prepareFragmentHtml } from './transforms.js';

/**
 * What the rebuild must not change: on well-formed markup the old rewriter was right, so the DOM a
 * parser builds from the new output must be the one it builds from the old output. (Bytes differ in
 * places: a literal `<` in text is written `&lt;`, CDATA as text, an `<image>` as `<img>`.) And it
 * must not cost much more to run.
 */

const streamOf = (markup: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(markup));
      controller.close();
    },
  });

const prepare = (markup: string) => new Response(prepareFragmentHtml(streamOf(markup), { fragmentId: 'f' })).text();
const legacyPrepare = (markup: string) => new Response(legacyPrepareFragmentHtml(streamOf(markup), { fragmentId: 'f' })).text();

/** The DOM of a fragment as pierced, serialized. */
function dom(output: string): string {
  const document = parse(
    `<!DOCTYPE html><html><head></head><body><fragment-slot><template shadowrootmode="open"><braid-document>` +
      `${output}</braid-document></template></fragment-slot></body></html>`,
  );
  type Element = DefaultTreeAdapterTypes.Element;
  const find = (node: DefaultTreeAdapterTypes.ParentNode, name: string): Element | undefined => {
    for (const child of node.childNodes) {
      if (!('tagName' in child)) continue;
      if (child.tagName === name) return child;
      const inner = find('content' in child && child.content ? child.content : child, name);
      if (inner) return inner;
    }
    return undefined;
  };
  return serialize(find(document, 'braid-document')!);
}

describe('fidelity on well-formed markup', () => {
  const pages = wellFormedPages(1500, 20261122);

  it('the DOM is the one the old rewriter produced', async () => {
    const failures: string[] = [];
    for (const [index, page] of pages.entries()) {
      const [ours, theirs] = [dom(await prepare(page)), dom(await legacyPrepare(page))];
      if (ours !== theirs) failures.push(`#${index} ${JSON.stringify(page)}\n  ours:   ${ours}\n  theirs: ${theirs}`);
      if (failures.length >= 3) break;
    }
    expect(failures.join('\n\n')).toBe('');
  }, 120_000);

  it('a tag nothing modifies is written byte for byte', async () => {
    for (const page of pages.slice(0, 300)) {
      const output = await prepare(page);
      for (const tag of page.match(/<(div|p|span|section|ul|li|td|th|tr|table|g|rect|mi|mrow|details|summary)(\s[^<>]*)?>/g) ?? []) {
        expect(output).toContain(tag);
      }
    }
  });
});

describe('throughput', () => {
  it('rewrites a 5 MB document in at most twice the old rewriter’s time', async () => {
    let document = '';
    for (const page of wellFormedPages(400, 9)) {
      document += page.replace(/<!DOCTYPE html>|<\/?(html|head|body)[^>]*>/g, '');
      if (document.length > 5_000_000) break;
    }
    while (document.length < 5_000_000) document += document.slice(0, 5_000_000 - document.length);
    // chunked as a network response would be
    const stream = (markup: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = new TextEncoder().encode(markup);
          for (let at = 0; at < bytes.length; at += 16_384) controller.enqueue(bytes.slice(at, at + 16_384));
          controller.close();
        },
      });
    const time = async (run: (body: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>) => {
      let best = Infinity;
      for (let attempt = 0; attempt < 5; attempt++) {
        const started = performance.now();
        await new Response(run(stream(document))).arrayBuffer();
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const legacy = await time((body) => legacyPrepareFragmentHtml(body, { fragmentId: 'f' }));
    const rebuilt = await time((body) => prepareFragmentHtml(body, { fragmentId: 'f' }));
    console.info(`5 MB: old rewriter ${legacy.toFixed(0)} ms, rebuilt ${rebuilt.toFixed(0)} ms (${(rebuilt / legacy).toFixed(2)}x)`);
    expect(rebuilt / legacy).toBeLessThanOrEqual(2);
  }, 300_000);
});

describe('cost on hostile markup', () => {
  // Tracking the tree must not make a tag cost more the deeper the document is: a fragment of
  // deep nesting and many end tags would otherwise hold the gateway for minutes.
  const shapes: [string, (depth: number) => string][] = [
    ['unmatched end tags under deep nesting', (n) => '<div>'.repeat(n) + '</span>'.repeat(n)],
    ['end tags blocked by a table cell', (n) => '<b><table><tr><td>' + '<span>'.repeat(n) + '</b>'.repeat(n)],
    ['block tags under deep nesting', (n) => '<p>' + '<span>'.repeat(n) + '<div></div>'.repeat(n)],
    ['table structure under deep nesting', (n) => '<table><tr><td>' + '<span>'.repeat(n) + '<tr>'.repeat(n)],
    ['end tags in deep SVG', (n) => '<svg>' + '<g>'.repeat(n) + '</x>'.repeat(n)],
    ['end tags in a deep HTML island', (n) => '<svg><foreignObject>' + '<span>'.repeat(n) + '</b>'.repeat(n)],
    ['list items in a deep HTML island', (n) => '<svg><foreignObject><li>' + '<span>'.repeat(n) + '<li>'.repeat(n)],
    ['select content under deep nesting', (n) => '<div>'.repeat(n) + '<select>' + '<option>'.repeat(n)],
  ];

  it.each(shapes)('%s: linear in the size of the input', async (_, shape) => {
    const run = async (depth: number) => {
      const started = performance.now();
      await prepare(shape(depth));
      return performance.now() - started;
    };
    await run(2_000);
    const [small, large] = [await run(10_000), await run(40_000)];
    // four times the input in well under sixteen times the time
    expect(large / Math.max(small, 1)).toBeLessThan(8);
  }, 120_000);
});

describe('cost on long tokens split across many chunks', () => {
  // A tag, comment or section still incomplete at the end of a chunk is not read again from its start
  // when the next chunk arrives: one long value in small chunks would cost its length squared.
  const shapes: [string, (size: number) => string][] = [
    ['a quoted attribute value', (n) => `<div title="${'a'.repeat(n)}">x</div>`],
    ['an unquoted attribute value', (n) => `<div title=${'a'.repeat(n)}>x</div>`],
    ['many attributes', (n) => `<div ${'a '.repeat(n / 2)}>x</div>`],
    ['many distinct attributes', (n) => `<div ${Array.from({ length: n / 8 }, (_, i) => `a${i}`).join(' ')}>x</div>`],
    ['a quoted value full of >', (n) => `<div title="${'>'.repeat(n)}">x</div>`],
    ['a comment full of >', (n) => `<!--a${'>'.repeat(n)}-->`],
    ['a tag name', (n) => `<d${'a'.repeat(n)}>x`],
    ['a comment', (n) => `<!--${'a-'.repeat(n / 2)}-->`],
    ['a bogus comment', (n) => `<?${'a'.repeat(n)}>`],
    ['raw text', (n) => `<style>${'a<'.repeat(n / 2)}</style>`],
    ['script data', (n) => `<script><!--${'<s'.repeat(n / 2)}--></script>`],
  ];

  it.each(shapes)('%s: linear in its length', async (_, shape) => {
    const run = async (size: number) => {
      const markup = shape(size);
      const chunks: string[] = [];
      for (let at = 0; at < markup.length; at += 1_024) chunks.push(markup.slice(at, at + 1_024));
      const started = performance.now();
      await new Response(
        prepareFragmentHtml(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
              controller.close();
            },
          }),
          { fragmentId: 'f' },
        ),
      ).text();
      return performance.now() - started;
    };
    await run(100_000);
    const [small, large] = [await run(500_000), await run(2_000_000)];
    console.info(`${_}: 0.5 MB ${small.toFixed(1)} ms, 2 MB ${large.toFixed(1)} ms`);
    expect(large / Math.max(small, 1)).toBeLessThan(8);
  }, 300_000);
});

