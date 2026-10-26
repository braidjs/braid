import { sections } from '../fragments';
import { canonicalUrl, DOCS, ORIGIN, type Page } from './layout';
import { decode, toMarkdown } from './markdown';
import cheatsheetBody from './partials/cheatsheet.html';
import howItsBuiltBody from './partials/how-its-built.html';
import masthead from './partials/masthead.html';

/**
 * What crawlers read: robots.txt, the sitemap, and llms.txt with its full-text companion.
 *
 * The homepage's sections live in declarative shadow roots, which search engines render but most AI
 * crawlers skip, so llms-full.txt carries the same words as plain text. It's made from the same
 * section sources as the page, never by hand, so the two can't drift.
 */
export function crawlFiles(pages: Page[]): Page[] {
  const indexed = pages.filter((page) => page.path.endsWith('.html') && !page.noindex);
  return [
    { path: 'robots.txt', html: `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n` },
    {
      path: 'sitemap.xml',
      html: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        ...indexed.map((page) => `  <url><loc>${canonicalUrl(page.path)}</loc></url>`),
        '</urlset>',
        '',
      ].join('\n'),
    },
    { path: 'llms.txt', html: llmsIndex(indexed) },
    { path: 'llms-full.txt', html: llmsFull(indexed) },
  ];
}

const home = `${ORIGIN}/`;

/** The llms.txt index: a summary, then links (https://llmstxt.org). */
function llmsIndex(pages: Page[]): string {
  const { description } = summary(pages.find((page) => page.path === 'index.html'));
  const lines = (links: Array<[string, string, string?]>) => links.map(([title, url, note]) => `- [${title}](${url})${note ? `: ${note}` : ''}`).join('\n');
  return `# Braid

> ${description}

Braid is open source (MIT) and published on npm under @braidlabs.

## This site

${lines([
  ...pages.map((page): [string, string, string] => {
    const { title, description: note } = summary(page);
    return [title, canonicalUrl(page.path), note];
  }),
  ['The homepage and reference pages as plain text', `${ORIGIN}/llms-full.txt`],
])}

## Docs

${lines([
  ['Getting started', `${DOCS}/getting-started`],
  ['Braid, explained', `${DOCS}/braid-explained`],
  ['When things go wrong', `${DOCS}/braid-failure-modes`],
  ['Running without a server', `${DOCS}/braid-without-gateway`],
  ['Packages', `${DOCS}/packages/`],
])}

## Source

${lines([
  ['GitHub', 'https://github.com/braidjs/braid'],
  ['npm: @braidlabs', 'https://www.npmjs.com/org/braidlabs'],
  ['StackBlitz demo', 'https://stackblitz.com/github/braidjs/braid/tree/main/examples/acme-portal'],
])}
`;
}

/** Every indexed page's words, homepage first, each under the URL it came from. */
function llmsFull(pages: Page[]): string {
  const { description } = summary(pages.find((page) => page.path === 'index.html'));
  // The wordmark <h1> is just "braid"; this file's own title says it.
  const parts = [
    `Source: ${home}\n\n${toMarkdown(masthead.replace(/<h1\b[\s\S]*?<\/h1>/, ''), home)}`,
    ...sections.map(({ id, markup }) => `Source: ${home}#${id}\n\n${toMarkdown(markup, home)}`),
    `Source: ${ORIGIN}/cheatsheet/\n\n${toMarkdown(cheatsheetBody, `${ORIGIN}/cheatsheet/`)}`,
    `Source: ${ORIGIN}/how-its-built/\n\n${toMarkdown(howItsBuiltBody, `${ORIGIN}/how-its-built/`)}`,
  ];
  return `# Braid\n\n> ${description}\n\n${parts.join('\n\n---\n\n')}\n`;
}

/** A built page's title and description, read back from its <head>. */
function summary(page: Page | undefined): { title: string; description: string } {
  const html = page?.html ?? '';
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
  const description = /<meta name="description" content="([^"]*)">/.exec(html)?.[1] ?? '';
  return { title: decode(title), description: decode(description) };
}
