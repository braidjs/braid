/**
 * The site's hand-written markup as Markdown, for llms-full.txt. Scoped to the elements the site
 * uses, not general HTML: an element with no rule here stops the build instead of flattening
 * silently, so a new kind of markup gets a rule before it ships.
 */

/** Every element left to strip once the rules below have run. */
const KNOWN =
  'a|article|aside|b|blockquote|br|caption|code|dd|div|dl|dt|em|figcaption|figure|footer|h[1-6]|header|i|li|main|ol|p|section|span|strong|sup|table|tbody|td|th|thead|tr|ul';
const KNOWN_TAG = new RegExp(`</?(?:${KNOWN})\\b[^>]*>`, 'g');

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#160;': ' ', '&nbsp;': ' ', '&amp;': '&' };
export const decode = (text: string) => text.replace(/&(?:lt|gt|quot|#39|#160|nbsp|amp);/g, (entity) => ENTITIES[entity] ?? entity);
const stripTags = (html: string) => html.replace(KNOWN_TAG, '');
const inline = (html: string) => stripTags(html.replace(/<br\s*\/?>/g, ' ')).replace(/\s+/g, ' ').trim();

// Code blocks wait behind private-use placeholders, so the steps below leave their whitespace alone.
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);

export function toMarkdown(html: string, pageUrl: string): string {
  const origin = new URL(pageUrl).origin;
  const code: string[] = [];
  const text = html
    .replaceAll('%CONTACT%', `${origin}/contact/`)
    .replaceAll('%BASE%', `${origin}/`)
    .replace(/<!--[\s\S]*?-->/g, '')
    // Decoration, controls, and the "show the seams" labels: not content.
    .replace(/<(style|svg|nav|button)\b[\s\S]*?<\/\1>/g, '')
    .replace(/<div class="seam"[\s\S]*?<\/div>/g, '')
    // The box-drawing diagram reads as noise; its aria-label already says what it shows.
    .replace(/<div class="dg-row">.*<\/div>/g, '')
    .replace(/<div class="dg"[^>]*aria-label="([^"]*)"[^>]*>/g, '\n\n$1\n\n')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/g, (_, body: string) => {
      code.push(decode(stripTags(body)).replace(/^\n+|\s+$/g, ''));
      return `\n\n${OPEN}${code.length - 1}${CLOSE}\n\n`;
    })
    // Adjacent elements laid out apart would otherwise run their words together.
    .replace(/<\/[a-z0-9]+>(?=<)/g, '$& ')
    .replace(/<table\b[^>]*>([\s\S]*?)<\/table>/g, (_, table: string) => {
      const caption = /<caption\b[^>]*>([\s\S]*?)<\/caption>/.exec(table)?.[1];
      const [head = [], ...body] = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
        [...(row[1] ?? '').matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) => inline(cell[1] ?? '').replace(/\|/g, '\\|')),
      );
      const rows = [head, head.map(() => '---'), ...body].map((cells) => `| ${cells.join(' | ')} |`);
      return `\n\n${caption ? `${inline(caption)}\n\n` : ''}${rows.join('\n')}\n\n`;
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g, (_, level: string, title: string) => `\n\n${'#'.repeat(Number(level))} ${inline(title)}\n\n`)
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_, href: string, label: string) => `[${inline(label)}](${new URL(decode(href), pageUrl).href})`)
    .replace(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*(?:<dd\b[^>]*>\s*)?/g, (_, term: string) => `\n- **${inline(term)}**: `)
    .replace(/<li\b[^>]*>/g, '\n- ')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/(p|div|section|article|figure|figcaption|aside|blockquote|ul|ol|dl|dd|table|caption|header|main|footer)>/g, '\n\n');
  // Escaped text is still `&lt;` here, so any `<` left is an element with no rule.
  const stripped = stripTags(text);
  const unknown = /<\/?[a-z][a-z0-9-]*/i.exec(stripped);
  if (unknown) throw new Error(`toMarkdown: no rule for ${unknown[0]}> (in ${pageUrl}). Add one to src/pages/markdown.ts.`);
  return decode(stripped)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (_, i: string) => `\`\`\`\n${code[Number(i)]}\n\`\`\``);
}
