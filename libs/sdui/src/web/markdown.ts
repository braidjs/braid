import { type View, h } from './view.js';

/**
 * The Markdown A2UI's `Text` carries — "simple Markdown" — as views: headings, paragraphs, lists,
 * strong, emphasis and code. Nothing else: raw HTML in the source is text, because there is no way
 * here to make an element from a string, and a link is its words.
 */

export interface MarkdownResult {
  /** True when the text is a single run with no block structure: it can sit inside a button. */
  readonly inline: boolean;
  readonly views: readonly View[];
}

const LIMIT = 20_000;

/**
 * Inline markup: `**strong**`, `*em*`, `` `code` ``. A link — `[words](url)` — is drawn as its
 * words: the basic catalog's Text is "simple Markdown … without HTML, images, or links", and text
 * is often bound to data someone typed, so a link would be a lure in the host's own page. Each
 * run is bounded so a long line of markers costs little.
 */
/** Elements one text may make from its markup; past this, the rest is plain text. */
const MAX_INLINE = 200;

function inline(text: string, depth = 0, made = { count: 0 }): View[] {
  if (depth > 4 || made.count >= MAX_INLINE) return [text];
  const out: View[] = [];
  const pattern =
    /\*\*([^*\n]{1,1000}?)\*\*|\*([^*\s][^*\n]{0,999}?)\*|`([^`\n]{1,1000})`|\[([^\][\n]{1,500})\]\(([^()\s]{1,2000})\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (++made.count > MAX_INLINE) break;
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [, strong, em, code, words] = match;
    if (strong) out.push(h('strong', {}, ...inline(strong, depth + 1, made)));
    else if (em) out.push(h('em', {}, ...inline(em, depth + 1, made)));
    else if (code) out.push(h('code', {}, code));
    else if (words) out.push(...inline(words, depth + 1, made));
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function markdown(source: string): MarkdownResult {
  const made = { count: 0 };
  const text = source.length > LIMIT ? source.slice(0, LIMIT) : source;
  const all = text.replace(/\r\n?/g, '\n').split('\n');
  // Each line can be an element of its own; past MAX_INLINE lines the rest is one line of text.
  const lines =
    all.length > MAX_INLINE
      ? [...all.slice(0, MAX_INLINE), all.slice(MAX_INLINE).join(' ')]
      : all;
  const blocks: View[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const parts: View[] = [];
    paragraph.forEach((line, index) => {
      if (index > 0) parts.push(h('br'));
      parts.push(...inline(line, 0, made));
    });
    blocks.push(h('p', {}, ...parts));
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(
      h(
        list.ordered ? 'ol' : 'ul',
        {},
        ...list.items.map((item) => h('li', {}, ...inline(item, 0, made))),
      ),
    );
    list = null;
  };
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push(
        h(
          `h${(heading[1] as string).length}`,
          {},
          ...inline(heading[2] as string, 0, made),
        ),
      );
    } else if (bullet || numbered) {
      flushParagraph();
      const ordered = !bullet;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(((bullet ?? numbered) as RegExpExecArray)[1] as string);
    } else if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  // One paragraph and nothing else is inline: its contents, with no <p> around them.
  const only = blocks[0];
  if (blocks.length === 1 && typeof only !== 'string' && only?.tag === 'p')
    return { inline: true, views: only.children ?? [] };
  return { inline: blocks.length === 0, views: blocks };
}
