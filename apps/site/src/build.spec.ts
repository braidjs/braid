import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const app = resolve(import.meta.dirname, '..');
const FRAGMENTS = ['problem', 'glossary', 'braided', 'promises', 'start', 'parts'];
const PAGES = ['index.html', 'cheatsheet/index.html', 'how-its-built/index.html', 'contact/index.html', 'contact/thanks/index.html'];

let out: string;
const read = (path: string) => readFileSync(join(out, path), 'utf8');

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'braid-site-spec-'));
  execFileSync(process.execPath, [join(app, 'build.mjs'), '--out', out], { stdio: 'pipe' });
});

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('the built site', () => {
  it('is a folder of static files: the pages, the host runtime and six fragments', () => {
    for (const file of [...PAGES, 'core.js', 'contact.js', 'site.css', 'favicon.svg', '_headers', ...FRAGMENTS.map((n) => `f/${n}/main.js`)]) {
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
    for (const heading of [
      'Four teams, one website.',
      "Words you'll hear a lot, in plain English.",
      'This page is braided.',
      'Safe, untangled, and honest about the rest.',
      'Pick a path. Each one takes about ten minutes.',
      'Take what you need. Leave the rest.',
      'Fig. 1 · One page, with Braid running on it',
    ]) {
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
    expect(html).toContain('name="website"');
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

  it('registers <fragment-slot> in the host runtime, and keeps it out of the fragments', () => {
    expect(read('core.js')).toContain('fragment-slot');
    for (const name of FRAGMENTS) {
      const bundle = read(`f/${name}/main.js`);
      expect(bundle, name).toContain('__braidFragment');
      expect(bundle, name).not.toContain('customElements.define');
    }
  });
});
