import { describe, expect, it } from 'vitest';
import { violations } from '../../testing/invariants.js';
import { rewriteHtmlStream } from './html-rewrite-stream.js';
import { prepareFragmentHtml } from './transforms.js';

/**
 * The canonical output a fragment is written in (`open-elements.ts`): what browsers recover from
 * differently closed explicitly or dropped, and the fragment kept inside its element. Each vector is
 * also split at every offset, and its output parsed for what must not survive.
 */

const streamOf = (pieces: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece));
      controller.close();
    },
  });

const prepare = (pieces: string[]) => new Response(prepareFragmentHtml(streamOf(pieces), { fragmentId: 'f' })).text();

async function canonical(markup: string): Promise<string> {
  const whole = await prepare([markup]);
  for (let cut = 1; cut < markup.length; cut++) {
    expect(await prepare([markup.slice(0, cut), markup.slice(cut)]), `split at ${cut}`).toBe(whole);
  }
  expect(violations(whole), whole).toEqual([]);
  return whole;
}

describe('foreign content is closed explicitly', () => {
  it.each([
    ['a breakout tag closes the SVG it leaves', '<svg><g><div>x</div>', '<svg><g></g></svg><div>x</div>'],
    ['font with a color, face or size breaks out', '<svg><font color=red>x</font>', '<svg></svg><font color=red>x</font>'],
    ['font without one stays in the SVG', '<svg><font>x</font></svg>', '<svg><font>x</font></svg>'],
    ['</p> breaks out too', '<math><mi><mglyph></p>', '<math><mi><mglyph></mglyph></p></mi></math>'],
    ['an end tag for an element below closes the foreign ones above it', '<span><svg><g></span>', '<span><svg><g></g></svg></span>'],
    ['what is open at the end is closed', '<svg><foreignObject><b>x', '<svg><foreignObject><b>x</b></foreignobject></svg>'],
    ['CDATA is written as text', '<svg><![CDATA[a<b&c]]></svg>', '<svg>a&lt;b&amp;c</svg>'],
    ['an HTML island closes what an implied end tag would', '<svg><desc><p>a<div>b', '<svg><desc><p>a</p><div>b</div></desc></svg>'],
    ['and what misnesting would', '<svg><desc><b><i>x</b>y', '<svg><desc><b><i>x</i></b>y</desc></svg>'],
    [
      'table structure in an island is dropped, end tags too, without closing the island',
      '<svg><foreignObject><table><tr><td>x</td></tr></table></foreignObject></svg>',
      '<svg><foreignObject><!--braid-blocked table--><!--braid-blocked tr--><!--braid-blocked td-->x</foreignObject></svg>',
    ],
    [
      'an encoding the rewriter cannot decode is removed: not an integration point anywhere',
      '<math><annotation-xml encoding="text&NotAName;html"><style>x</style>',
      '<math><annotation-xml data-braid-blocked="encoding"><style>x</style></annotation-xml></math>',
    ],
  ])('%s', async (_, markup, expected) => {
    expect(await canonical(markup)).toBe(expected);
  });
});

describe('where browsers disagree, the construct is dropped', () => {
  it.each([
    [
      'raw text and foreign content in a select',
      '<select><style>a</style><svg><option>x</select>',
      '<select><!--braid-blocked style-->a<!--braid-blocked svg--><option>x</select>',
    ],
    ['what closes a select is written as </select>', '<select><input><select><select>', '<select></select><input><select></select>'],
    ['a column-group template takes nothing but col and template', '<template><col><style>x</template>', '<template><col><!--braid-blocked style-->x</template>'],
    ['noscript, with its content', '<noscript><p>x</noscript>after', '<!--braid-blocked noscript-->after'],
    ['frameset and frame', '<frameset><frame src=x>', '<!--braid-blocked frameset--><!--braid-blocked frame-->'],
    ['plaintext becomes escaped text in a pre', '<plaintext><b>x</b>', '<pre data-braid-blocked="plaintext">&lt;b>x&lt;/b>'],
    ['a bogus comment becomes a real one', '<?pi x?><!a>', '<!--?pi x?--><!--a-->'],
    ['</> is dropped', 'a</>b', 'ab'],
    ['a literal < is written as text that cannot pair with what follows', 'a<</body>b', 'a&lt;b'],
  ])('%s', async (_, markup, expected) => {
    expect(await canonical(markup)).toBe(expected);
  });
});

describe('a fragment stays inside its element', () => {
  it.each([
    ['end tags for the elements it is placed in are dropped', '</template></braid-document></fragment-slot></body>x', 'x'],
    ['but match the fragment’s own', '<template></template><braid-document></braid-document>', '<template></template><braid-document></braid-document>'],
    ['raw text left open is closed', '<textarea>x', '<textarea>x</textarea>'],
    ['so is a script left inside an escape', '<script><!--<script>x', '<script type="inert"><!--<script>x--></script>'],
    ['and a comment', '<!-- x', '<!-- x-->'],
    ['a tag the input ends inside is dropped', '<b><a title="x', '<b>'],
    ['an object left open is closed, so no formatting element outlives it', '<a href=#><object>', '<a href=#><object></object>'],
    ['as is one table structure would clear', '<b><table><object><tr>', '<b><table><object></object><tr>'],
    ['a template’s content is closed element by element', '<template><b><table><td>x</template>', '<template><b><table><td>x</td></table></b></template>'],
  ])('%s', async (_, markup, expected) => {
    expect(await canonical(markup)).toBe(expected);
  });
});

describe('what the code review found', () => {
  it.each([
    ['a tag named after an Object property is an ordinary element', '<p>a<constructor>b</constructor><toString>c</p>', '<p>a<constructor>b</constructor><toString>c</p>'],
    ['text across a dropped token does not join into a reference', '&no</body>t;x&am</template>p;y', '&amp;not;x&amp;amp;y'],
    ['a reference split only by a chunk is kept', 'a &amp; b &copy c', 'a &amp; b &copy c'],
    ['a rename survives an end tag that closes nothing', '<head><template></head></template></head><body>x', '<braid-head><template></braid-head></template></braid-head><braid-body>x'],
    ['a self-closing head is opened, and closed under its new name', '<head/><title>t</title></head>', '<braid-head/><title>t</title></braid-head>'],
    ['an authored data-braid-blocked keeps its references', '<img data-braid-blocked="a&amp;b" src="x&NotAName;">', '<img data-braid-blocked="a&amp;b src">'],
  ])('%s', async (_, markup, expected) => {
    expect(await canonical(markup)).toBe(expected);
  });
});

describe('a shell is not contained', () => {
  const ended = (markup: string) =>
    new Response(rewriteHtmlStream(streamOf([markup]), { handlers: {}, onEnd: () => '<script>late()</script>' })).text();

  it.each([
    ['a comment', '<p>x<!-- open', '<p>x<!-- open--><script>late()</script>'],
    ['a bogus comment', '<p>x<?pi', '<p>x<?pi><script>late()</script>'],
    ['a doctype', '<!DOCTYPE html', '<!DOCTYPE html><script>late()</script>'],
    ['a bare </', '<p>x</', '<p>x&lt;/<script>late()</script>'],
    ['a tag', '<p>x<div title="', '<p>x<script>late()</script>'],
  ])('closes %s the input ends inside, so what is appended is not swallowed', async (_, markup, expected) => {
    expect(await ended(markup)).toBe(expected);
  });

  it('leaves an <image> as written, and reads a tag named constructor as a tag', async () => {
    const markup = '<image src=a.png><constructor>x</constructor><p>after';
    expect(await new Response(rewriteHtmlStream(streamOf([markup]), { handlers: {} })).text()).toBe(markup);
  });

  it('reads <font> in SVG as the browser does: as SVG, unless it has a color, face or size', async () => {
    const seen: string[] = [];
    const markup = '<svg><font><style><b></b></style></font><font face=x><style><i></i></style></svg>';
    await new Response(rewriteHtmlStream(streamOf([markup]), { handlers: { '*': { element: (tag) => void seen.push(tag.tagName) } } })).text();
    expect(seen).toEqual(['svg', 'font', 'style', 'b', 'font', 'style']);
  });

  const shell = (markup: string) => new Response(rewriteHtmlStream(streamOf([markup]), { handlers: {} })).text();

  it('passes malformed markup through as it is', async () => {
    const markup = '<svg><g><div>x</div><select><style>a</style></select><?pi?><![CDATA[x]]></template><textarea>x';
    expect(await shell(markup)).toBe(markup);
  });

  it('still reads it as the browser does: no tag inside raw text, every tag outside it', async () => {
    const seen: string[] = [];
    const markup = '<svg><style><b></b></style></svg><style><i></i></style><xmp><u></u></xmp><s>';
    await new Response(rewriteHtmlStream(streamOf([markup]), { handlers: { '*': { element: (tag) => void seen.push(tag.tagName) } } })).text();
    expect(seen).toEqual(['svg', 'style', 'b', 'style', 'xmp', 's']);
  });
});
