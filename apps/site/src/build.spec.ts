import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const app = resolve(import.meta.dirname, '..');
const FRAGMENTS = ['problem', 'glossary', 'braided', 'promises', 'start', 'parts'];
const PAGES = ['index.html', 'cheatsheet/index.html', 'how-its-built/index.html', 'contact/index.html', 'contact/thanks/index.html'];
const CRAWL_FILES = ['robots.txt', 'sitemap.xml', 'llms.txt', 'llms-full.txt'];
const ORIGIN = 'https://oss.braidcloud.com';
const SECTION_HEADINGS = [
  'Four teams, one website.',
  "Words you'll hear a lot, in plain English.",
  'This page is braided.',
  'Safe, untangled, and honest about the rest.',
  'Pick a path. Each one takes about ten minutes.',
  'Take what you need. Leave the rest.',
];
/** A page's public URL, from its file: `cheatsheet/index.html` → `…/cheatsheet/`. */
const urlOf = (page: string) => `${ORIGIN}/${page.replace(/(^|\/)index\.html$/, '$1')}`;
const meta = (html: string, attr: 'name' | 'property', key: string) =>
  new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`).exec(html)?.[1];

let out: string;
const read = (path: string) => readFileSync(join(out, path), 'utf8');

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'braid-site-spec-'));
  execFileSync(process.execPath, [join(app, 'build.mjs'), '--out', out], { stdio: 'pipe' });
});

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('the built site', () => {
  it('is a folder of static files: the pages, the host runtime and six fragments', () => {
    for (const file of [
      ...PAGES,
      ...CRAWL_FILES,
      'core.js',
      'contact.js',
      'site.css',
      'favicon.svg',
      'og.png',
      '_headers',
      ...FRAGMENTS.map((n) => `f/${n}/main.js`),
    ]) {
      expect(existsSync(join(out, file)), file).toBe(true);
    }
  });

  it('mounts every homepage section as a contract fragment with a relative entry', () => {
    const html = read('index.html');
    const slots = [...html.matchAll(/<fragment-slot ([^>]*)>/g)].map((m) => m[1] ?? '');
    expect(slots).toHaveLength(FRAGMENTS.length);
    FRAGMENTS.forEach((name, i) => {
      expect(slots[i]).toContain(`name="${name}"`);
      expect(slots[i]).toContain('adapter="contract"');
      expect(slots[i]).toContain(`entry="./f/${name}/main.js"`);
    });
  });

  it('prerenders every section, so the raw HTML already reads as the page', () => {
    const html = read('index.html');
    expect(html.match(/<template shadowrootmode="open">/g)).toHaveLength(FRAGMENTS.length);
    for (const heading of [...SECTION_HEADINGS, 'Fig. 1 · One page, with Braid running on it']) {
      expect(html, heading).toContain(heading);
    }
  });

  it('points nothing at a gateway, and uses only relative URLs, so any static host and sub-path works', () => {
    for (const page of PAGES) {
      const urls = [...read(page).matchAll(/\b(?:src|href|entry)="([^"]*)"/g)].map((m) => m[1] ?? '');
      expect(urls.length, page).toBeGreaterThan(0);
      for (const url of urls) {
        expect(url, `${page}: ${url}`).not.toMatch(/__braid/);
        expect(url, `${page}: ${url}`).not.toMatch(/^\/(?!\/)/);
      }
    }
  });

  it('sends every anchor link to an id that exists where it points', () => {
    // Only light-DOM ids count: a URL fragment cannot reach an id inside a shadow root.
    const lightIds = (page: string) =>
      new Set(
        [...read(page).replace(/<template shadowrootmode="open">[\s\S]*?<\/template>/g, '').matchAll(/\bid="([^"]+)"/g)].map(
          (m) => m[1],
        ),
      );
    for (const page of PAGES) {
      for (const [, prefix, target] of read(page).matchAll(/\bhref="(\.\.\/|\.\/)?#([^"]+)"/g)) {
        const where = prefix === '../' ? 'index.html' : page;
        expect(lightIds(where).has(target), `${page}: ${prefix ?? ''}#${target}`).toBe(true);
      }
    }
  });

  it('sends every "Get in touch" link to the contact page, by a relative URL', () => {
    let links = 0;
    for (const page of PAGES) {
      for (const [, href] of read(page).matchAll(/<a href="([^"]*)"[^>]*>(?:Get in touch|Get in touch\.|Get in touch →)<\/a>/g)) {
        links++;
        expect(href, page).not.toMatch(/^(https?:|\/)/);
        const target = new URL(href ?? '', `https://site.test/${page}`).pathname;
        expect(target, `${page}: ${href}`).toBe('/contact/');
      }
    }
    expect(links).toBeGreaterThanOrEqual(PAGES.length);
  });

  it('posts the contact form, with a Turnstile widget and a honeypot, to api/contact', () => {
    const html = read('contact/index.html');
    const action = html.match(/<form id="contact-form"[^>]*action="([^"]+)"/)?.[1] ?? '';
    expect(new URL(action, 'https://site.test/contact/index.html').pathname).toBe('/api/contact');
    expect(html).toMatch(/method="post"/);
    expect(html).toMatch(/class="cf-turnstile" data-sitekey="[^"%]+"/);
    expect(html).toContain('name="hp_extra"');
    expect(html).toContain('data-action="contact"');
    for (const field of ['name', 'email', 'company', 'message']) expect(html).toContain(`name="${field}"`);
  });

  it('ships security headers that still let blob: realms boot', () => {
    const headers = read('_headers');
    const csp = headers.match(/Content-Security-Policy: (.+)/)?.[1] ?? '';
    expect(csp).toMatch(/frame-src [^;]*blob:/);
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).toMatch(/form-action 'self'/);
    expect(headers).toContain('X-Content-Type-Options: nosniff');
  });

  it('leaves no design-tool syntax behind', () => {
    for (const page of PAGES) {
      expect(read(page), page).not.toMatch(/\{\{|<sc-if|%BASE%|%CONTACT%|%TURNSTILE_SITEKEY%|<x-dc|<helmet/);
    }
  });

  it('gives every page a canonical URL and share-card tags, and keeps only the thanks page out of search', () => {
    for (const page of PAGES) {
      const html = read(page);
      const canonicals = [...html.matchAll(/<link rel="canonical" href="([^"]*)">/g)].map((m) => m[1]);
      expect(canonicals, page).toEqual([urlOf(page)]);
      expect(meta(html, 'property', 'og:url'), page).toBe(urlOf(page));
      expect(meta(html, 'property', 'og:title'), page).toBe(/<title>([^<]*)<\/title>/.exec(html)?.[1]);
      expect(meta(html, 'property', 'og:image'), page).toBe(`${ORIGIN}/og.png`);
      expect(meta(html, 'name', 'twitter:card'), page).toBe('summary_large_image');
      expect(meta(html, 'name', 'robots'), page).toBe(page === 'contact/thanks/index.html' ? 'noindex' : undefined);
    }
    // The card the tags promise: a 1200×630 PNG (width and height from its IHDR chunk).
    const png = readFileSync(join(out, 'og.png'));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  });

  it('describes the project to search engines on the homepage only, with facts from the page and no rich-result claims', () => {
    const blocks = (page: string) => [...read(page).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
    for (const page of PAGES.filter((p) => p !== 'index.html')) expect(blocks(page), page).toEqual([]);
    expect(blocks('index.html')).toHaveLength(1);
    const [json = ''] = blocks('index.html');
    const data = JSON.parse(json) as { '@graph': Array<Record<string, unknown>> };
    expect(data['@graph'].map((node) => node['@type'])).toEqual(['WebSite', 'SoftwareSourceCode']);
    expect(data['@graph'][1]).toMatchObject({
      codeRepository: 'https://github.com/braidjs/braid',
      programmingLanguage: 'TypeScript',
      description: meta(read('index.html'), 'name', 'description'),
    });
    // The license the data names is the one the page shows.
    expect(read('index.html')).toContain('Open source · MIT');
    expect(json).not.toMatch(/aggregateRating|review|offers|SearchAction/);
  });

  it('lists exactly the indexable pages in the sitemap, and points robots.txt at it', () => {
    const locs = [...read('sitemap.xml').matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(PAGES.filter((page) => !read(page).includes('content="noindex"')).map(urlOf));
    expect(read('robots.txt')).toMatch(/^User-agent: \*\nAllow: \/\n/);
    expect(read('robots.txt')).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    expect(read('robots.txt')).not.toMatch(/Disallow: \/\s*$/m);
  });

  it('gives AI crawlers the homepage words as plain text, made from the same section sources', () => {
    const index = read('llms.txt');
    expect(index).toMatch(/^# Braid\n\n> \S/);
    expect(index).toContain(`(${ORIGIN}/llms-full.txt)`);
    for (const [, url] of index.matchAll(/\]\((https:\/\/oss\.braidcloud\.com\/[^)]*)\)/g)) {
      const file = (url ?? '').slice(ORIGIN.length + 1);
      expect(existsSync(join(out, file.endsWith('/') || file === '' ? `${file}index.html` : file)), url).toBe(true);
    }
    // Served without a charset, so anything past ASCII would be misread (see crawl.ts).
    for (const file of ['llms.txt', 'llms-full.txt']) expect(read(file), file).toMatch(/^[\t\n\r -~]*$/);
    expect(index).toContain('# Braid\n\n> Braid puts apps');
    const full = read('llms-full.txt');
    // "How this page<br>is braided." keeps its space.
    for (const heading of [...SECTION_HEADINGS, 'Braid puts apps from different teams on one page', '# The cheatsheet.', '# How this page is braided.']) {
      expect(full, heading).toContain(heading);
    }
    expect(full).toContain('```\nimport { defineFragment }');
    // An unknown element already fails the build (markdown.ts); this catches attribute and entity
    // leaks. Code blocks are exempt: their examples are HTML on purpose.
    expect(full.replace(/```[\s\S]*?```/g, '')).not.toMatch(/<(span|div|p|b|a|br|svg|dt|dd|li|table|t[rdh]|code|h[1-6])\b|style="|&(lt|gt|amp|quot|#160);|%BASE%|%CONTACT%|Show the seams/);
  });

  it('registers <fragment-slot> in the host runtime, and keeps it out of the fragments', () => {
    expect(read('core.js')).toContain('fragment-slot');
    for (const name of FRAGMENTS) {
      const bundle = read(`f/${name}/main.js`);
      expect(bundle, name).toContain('__braidFragment');
      expect(bundle, name).not.toContain('customElements.define');
    }
  });
});
