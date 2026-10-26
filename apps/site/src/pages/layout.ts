import colophon from './partials/colophon.html';

const FONTS =
  'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,200..800' +
  '&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;700&display=swap';

export const DOCS = 'https://braidjs.github.io/braid';

/**
 * Where the site lives. Only what has to be absolute uses it: the canonical and share-card URLs,
 * the sitemap and the llms files. Everything else stays relative. Keep it the hostname the stack
 * attaches to Amplify (infra/app.ts).
 */
export const ORIGIN = 'https://oss.braidcloud.com';

/** A page's public URL, from where its file goes: `cheatsheet/index.html` → `…/cheatsheet/`. */
export const canonicalUrl = (path: string) => `${ORIGIN}/${path.replace(/(^|\/)index\.html$/, '$1')}`;

/**
 * The Turnstile site key the contact form renders with. CI sets the real one; without it, local
 * builds use Cloudflare's published test key, which always passes.
 */
const TURNSTILE_SITEKEY = process.env['SITE_TURNSTILE_SITEKEY'] || '1x00000000000000000000AA';

export interface Page {
  /** Where the file goes in the output, e.g. `cheatsheet/index.html`. */
  path: string;
  /** The file's content: a page's HTML, or the text of a crawler file. */
  html: string;
  /** Kept out of search results and the sitemap. */
  noindex?: boolean;
}

interface LayoutOptions {
  /** The page's own `Page.path`, for its canonical URL. */
  path: string;
  title: string;
  description: string;
  /**
   * The relative way back to the site root from this page: `./` or `../`. Keeps the site movable,
   * apart from the canonical and share-card tags, which name ORIGIN on purpose.
   */
  base: string;
  body: string;
  /** Load the host runtime. Only the homepage composes fragments. */
  braid?: boolean;
  noindex?: boolean;
  /** Extra tags for <head>, e.g. the contact page's scripts. `%BASE%` works here too. */
  head?: string;
  bodyAttributes?: string;
}

const escapeAttr = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function layout({ path, title, description, base, body, braid = false, noindex = false, head = '', bodyAttributes = '' }: LayoutOptions): string {
  const url = escapeAttr(canonicalUrl(path));
  // Every "Get in touch" link reads %CONTACT%: the contact page, relative, so the site stays movable.
  const fill = (html: string) =>
    html
      .replaceAll('%BASE%', base)
      .replaceAll('%CONTACT%', `${base}contact/`)
      .replaceAll('%TURNSTILE_SITEKEY%', escapeAttr(TURNSTILE_SITEKEY));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(title)}</title>
<meta name="description" content="${escapeAttr(description)}">
<link rel="canonical" href="${url}">
${noindex ? '<meta name="robots" content="noindex">\n' : ''}<meta property="og:type" content="website">
<meta property="og:site_name" content="Braid">
<meta property="og:title" content="${escapeAttr(title)}">
<meta property="og:description" content="${escapeAttr(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ORIGIN}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Braid: the safe microfrontend orchestrator">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${base}favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${escapeAttr(FONTS)}">
<link rel="stylesheet" href="${base}site.css">
${braid ? `<script type="module" src="${base}core.js"></script>\n` : ''}${head ? `${fill(head)}\n` : ''}</head>
<body${bodyAttributes ? ` ${bodyAttributes}` : ''}>
${fill(body)}
${fill(colophon)}
</body>
</html>
`;
}

/** The compact nav the two reference pages share. */
export function subnav(base: string): string {
  const link = (href: string, text: string) => `<a href="${href}" class="nav-link">${text}</a>`;
  return `<header class="wrap" style="padding-top: 20px">
  <nav aria-label="Primary" style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 24px; padding-bottom: 10px; border-bottom: 6px solid #121116">
    <a href="${base}" style="display: flex; align-items: center; gap: 10px; min-height: 44px; text-decoration: none; font-weight: 800; font-size: 22px; letter-spacing: -0.04em">
      <svg width="34" height="22" viewBox="0 0 34 22" aria-hidden="true"><path d="M1 11 C6 1, 11 1, 17 11 S28 21, 33 11" fill="none" stroke="#121116" stroke-width="3.5" stroke-linecap="round"></path><path d="M1 11 C6 21, 11 21, 17 11 S28 1, 33 11" fill="none" stroke="#3346FF" stroke-width="3.5" stroke-linecap="round"></path></svg>
      braid
    </a>
    <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 2px; font-size: 15px; font-weight: 500">
      ${link(`${base}#how`, 'How it works')}
      ${link(`${DOCS}/`, 'Docs')}
      ${link(`${base}cheatsheet/`, 'Cheatsheet')}
      ${link('https://github.com/braidjs/braid', 'GitHub')}
    </div>
    <p style="margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0 6px; font-size: 15px">
      <span style="color: #5B5750">Interested in hosted Braid?</span>
      <a href="%CONTACT%" style="display: inline-flex; align-items: center; min-height: 44px; font-weight: 700; text-decoration-thickness: 1.5px; text-underline-offset: 4px">Get in touch.</a>
    </p>
  </nav>
</header>`;
}
