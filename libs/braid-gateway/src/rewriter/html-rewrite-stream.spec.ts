import { describe, expect, it } from 'vitest';
import { concatStreams, rewriteHtmlStream, RewriteOptions } from './html-rewrite-stream.js';

/**
 * Conformance vectors for the owned streaming rewriter.
 *
 * Every vector runs twice: once with the whole document in a single chunk, and once split into
 * one-character chunks. Identical output from both is what "chunk-boundary safe" means, and it
 * is the property most likely to rot — so it is asserted on every case rather than a few.
 */

function streamOf(html: string, chunkSize = Infinity): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = chunkSize === Infinity ? [html] : (html.match(new RegExp(`[\\s\\S]{1,${chunkSize}}`, 'g')) ?? []);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await new Response(stream).arrayBuffer()));
}

/** Runs a rewrite whole and byte-by-byte, asserts the two agree, and returns the output. */
async function rewriteBothWays(html: string, makeOptions: () => RewriteOptions): Promise<string> {
  const whole = await collect(rewriteHtmlStream(streamOf(html), makeOptions()));
  const split = await collect(rewriteHtmlStream(streamOf(html, 1), makeOptions()));

  expect(split, 'output must not depend on how the input was chunked').toBe(whole);
  return whole;
}

const renameHandlers = (): RewriteOptions => ({
  handlers: {
    html: { element: (tag) => void (tag.tagName = 'braid-html') },
    head: { element: (tag) => void (tag.tagName = 'braid-head') },
    body: { element: (tag) => void (tag.tagName = 'braid-body') },
  },
});

describe('rewriteHtmlStream — pass-through fidelity', () => {
  it('emits untouched documents byte-for-byte', async () => {
    const html =
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title></head>` +
      `<body class='x' data-empty><p>hi &amp; bye</p><!-- note --><br/></body></html>`;

    expect(await rewriteBothWays(html, () => ({ handlers: {} }))).toBe(html);
  });

  it('preserves attribute quoting and spacing on tags it does not modify', async () => {
    const html = `<div   id=unquoted class='single'  data-json="{&quot;a&quot;:1}"  hidden >x</div>`;
    expect(await rewriteBothWays(html, () => ({ handlers: { span: { element: () => undefined } } }))).toBe(html);
  });

  it('treats a bare < as text, not a tag', async () => {
    const html = `<p>1 < 2 and 3 > 2</p>`;
    expect(await rewriteBothWays(html, () => ({ handlers: {} }))).toBe(html);
  });
});

describe('rewriteHtmlStream — tag renaming', () => {
  it('renames elements while preserving their attributes', async () => {
    const output = await rewriteBothWays(
      `<html lang="en"><head><title>T</title></head><body class="a b">x</body></html>`,
      renameHandlers,
    );

    expect(output).toBe(
      `<braid-html lang="en"><braid-head><title>T</title></braid-head>` +
        `<braid-body class="a b">x</braid-body></braid-html>`,
    );
  });

  it('renames the matching end tag, so the renamed element actually closes', async () => {
    // if </head> were left alone, braid-head would never close and braid-body would parse as
    // its child — the whole fragment would end up inside the head
    const output = await rewriteBothWays(`<head><title>T</title></head><body>x</body>`, renameHandlers);
    expect(output).toBe(`<braid-head><title>T</title></braid-head><braid-body>x</braid-body>`);
  });

  it('renames end tags of nested same-name elements at the right depth', async () => {
    const output = await rewriteBothWays(`<b><b>x</b>y</b>z`, () => ({
      handlers: { b: { element: (tag) => void (tag.tagName = 'braid-b') } },
    }));

    expect(output).toBe(`<braid-b><braid-b>x</braid-b>y</braid-b>z`);
  });

  it('leaves end tags of elements it did not rename alone', async () => {
    const output = await rewriteBothWays(`<body><p>x</p></body>`, renameHandlers);
    expect(output).toBe(`<braid-body><p>x</p></braid-body>`);
  });
});

describe('rewriteHtmlStream — attributes', () => {
  it('adds, replaces, and removes attributes', async () => {
    const output = await rewriteBothWays(`<script type="module" src="/a.js" defer></script>`, () => ({
      handlers: {
        script: {
          element(tag) {
            expect(tag.getAttribute('type')).toBe('module');
            expect(tag.getAttribute('defer')).toBeNull();
            expect(tag.getAttribute('missing')).toBeNull();
            tag.setAttribute('data-script-type', tag.getAttribute('type')!);
            tag.setAttribute('type', 'inert');
            tag.removeAttribute('src');
          },
        },
      },
    }));

    expect(output).toBe(`<script type="inert" defer data-script-type="module"></script>`);
  });

  it('decodes entities on read and re-escapes on write', async () => {
    const output = await rewriteBothWays(`<a title="a &amp; b &quot;c&quot;" href="/x?a=1&amp;b=2">l</a>`, () => ({
      handlers: {
        a: {
          element(tag) {
            expect(tag.getAttribute('title')).toBe('a & b "c"');
            expect(tag.getAttribute('href')).toBe('/x?a=1&b=2');
            tag.setAttribute('data-seen', '');
          },
        },
      },
    }));

    expect(output).toBe(`<a title="a &amp; b &quot;c&quot;" href="/x?a=1&amp;b=2" data-seen="">l</a>`);
  });

  it('matches tag and attribute names case-insensitively', async () => {
    const output = await rewriteBothWays(`<SCRIPT TYPE="module"></SCRIPT>`, () => ({
      handlers: {
        script: {
          element(tag) {
            expect(tag.getAttribute('type')).toBe('module');
            tag.setAttribute('TYPE', 'inert');
          },
        },
      },
    }));

    expect(output).toBe(`<script TYPE="inert"></SCRIPT>`);
  });

  /** The attribute names a handler sees for one start tag, after a no-op rewrite. */
  async function attributeNamesOf(markup: string): Promise<string[][]> {
    const seen: string[][] = [];
    await rewriteBothWays(markup, () => ({
      handlers: { div: { element: (tag) => void seen.push(tag.attributeNames) } },
    }));
    // rewriteBothWays runs the handlers twice; both runs must agree
    expect(seen[1]).toEqual(seen[0]);
    return seen.slice(0, 1);
  }

  it('splits attribute names where the HTML tokenizer does', async () => {
    // `/` separates attributes, and a leading `=` starts a name rather than ending one
    expect(await attributeNamesOf(`<div a/b="1" =c=2 d/>`)).toEqual([['a', 'b', '=c', 'd']]);
  });

  it('keeps the first of a repeated attribute, as the browser does', async () => {
    const output = await rewriteBothWays(`<div id="first" ID="second" title="t">`, () => ({
      handlers: {
        div: {
          element(tag) {
            expect(tag.getAttribute('id')).toBe('first');
            tag.removeAttribute('id');
            // with the first gone there is no second to promote
            expect(tag.getAttribute('id')).toBeNull();
          },
        },
      },
    }));

    expect(output).toBe(`<div title="t">`);
  });
});

describe('rewriteHtmlStream — raw text elements', () => {
  it('does not interpret markup inside script bodies', async () => {
    const html = `<script>if (a < b && c > d) { x('</div>'); }</script><p>after</p>`;
    let paragraphsSeen = 0;

    const output = await rewriteBothWays(html, () => ({
      handlers: { p: { element: () => void paragraphsSeen++ } },
    }));

    expect(output).toBe(html);
    // both runs see it exactly once
    expect(paragraphsSeen).toBe(2);
  });

  it('does not treat a lookalike prefix as the end tag', async () => {
    const html = `<script>var s = "</scriptfoo>";</script>`;
    expect(await rewriteBothWays(html, () => ({ handlers: {} }))).toBe(html);
  });

  it('handles style, title, and textarea as raw text too', async () => {
    const html = `<style>a::after{content:"<b>"}</style><title>a < b</title><textarea><p></textarea>`;
    expect(await rewriteBothWays(html, () => ({ handlers: {} }))).toBe(html);
  });

  it('does not enter raw text mode for a self-closing script', async () => {
    const html = `<script src="/a.js"/><p>after</p>`;
    let sawParagraph = false;
    await rewriteBothWays(html, () => ({ handlers: { p: { element: () => void (sawParagraph = true) } } }));
    expect(sawParagraph).toBe(true);
  });
});

describe('rewriteHtmlStream — comments, doctypes, declarations', () => {
  it('skips markup inside comments', async () => {
    const html = `<!-- <script>x</script> <body> --><p>real</p>`;
    let bodiesSeen = 0;
    const output = await rewriteBothWays(html, () => ({ handlers: { body: { element: () => void bodiesSeen++ } } }));

    expect(output).toBe(html);
    expect(bodiesSeen).toBe(0);
  });

  it('strips the doctype on request, and only the doctype', async () => {
    const output = await rewriteBothWays(`<!DOCTYPE html><html><body>x</body></html>`, () => ({
      handlers: {},
      stripDoctype: true,
    }));

    expect(output).toBe(`<html><body>x</body></html>`);
  });

  it('handles a doctype containing a quoted >', async () => {
    const html = `<!DOCTYPE html SYSTEM "about:legacy>compat"><p>x</p>`;
    expect(await rewriteBothWays(html, () => ({ handlers: {}, stripDoctype: true }))).toBe(`<p>x</p>`);
  });
});

describe('rewriteHtmlStream — injection', () => {
  it('injects before a start tag and after it (prepend)', async () => {
    const output = await rewriteBothWays(`<head><title>T</title></head>`, () => ({
      handlers: {
        head: {
          element(tag) {
            tag.before('<!--b-->');
            tag.prepend('<style>x</style>');
          },
        },
      },
    }));

    expect(output).toBe(`<!--b--><head><style>x</style><title>T</title></head>`);
  });

  it('injects before an end tag', async () => {
    const output = await rewriteBothWays(`<body><p>x</p></body>`, () => ({
      handlers: { body: { endTag: (tag) => tag.before('<footer></footer>') } },
    }));

    expect(output).toBe(`<body><p>x</p><footer></footer></body>`);
  });

  it('interleaves an injected stream into the output', async () => {
    const output = await collect(
      rewriteHtmlStream(streamOf(`<body><slot-here></slot-here>after</body>`), {
        handlers: {
          'slot-here': {
            element(tag) {
              tag.prepend(concatStreams(['<i>', streamOf('streamed'), '</i>']));
            },
          },
        },
      }),
    );

    expect(output).toBe(`<body><slot-here><i>streamed</i></slot-here>after</body>`);
  });

  it('emits onEnd content when the anchoring end tag never arrives', async () => {
    const output = await rewriteBothWays(`<body><p>x</p>`, () => {
      let injected = false;
      return {
        handlers: {
          body: {
            endTag(tag) {
              injected = true;
              tag.before('<at-end></at-end>');
            },
          },
        },
        onEnd: () => (injected ? undefined : '<at-end></at-end>'),
      };
    });

    expect(output).toBe(`<body><p>x</p><at-end></at-end>`);
  });

  it('does not double-emit when the end tag is present', async () => {
    const output = await rewriteBothWays(`<body><p>x</p></body>`, () => {
      let injected = false;
      return {
        handlers: {
          body: {
            endTag(tag) {
              injected = true;
              tag.before('<at-end></at-end>');
            },
          },
        },
        onEnd: () => (injected ? undefined : '<at-end></at-end>'),
      };
    });

    expect(output).toBe(`<body><p>x</p><at-end></at-end></body>`);
  });
});

describe('rewriteHtmlStream — streaming behavior', () => {
  it('emits shell output before a slow injected stream finishes', async () => {
    let releaseFragment!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFragment = resolve;
    });

    const fragment = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await gate;
        controller.enqueue(new TextEncoder().encode('LATE'));
        controller.close();
      },
    });

    const output = rewriteHtmlStream(streamOf(`<head></head><body><x-slot></x-slot></body>`), {
      handlers: {
        head: { element: (tag) => tag.prepend('<style>s</style>') },
        'x-slot': { element: (tag) => tag.prepend(fragment) },
      },
    });

    const reader = output.getReader();
    const decoder = new TextDecoder();
    let received = '';

    // everything up to the slot must be readable while the fragment is still blocked
    while (!received.includes('<x-slot>')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }

    expect(received).toContain('<style>s</style>');
    expect(received).not.toContain('LATE');

    releaseFragment();

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }

    expect(received).toBe(`<head><style>s</style></head><body><x-slot>LATE</x-slot></body>`);
  });
});
