import { describe, expect, it } from 'vitest';
import type { FragmentManifest } from '@braidlabs/gateway';
import { validateRegistry } from './analysis.js';
import { formatAreas, isSafeAssetUrl, isSafeTrackList, parseAreas, type ShellManifest } from './shell.js';

const billing: FragmentManifest = { id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'] };
const reviews: FragmentManifest = { id: 'reviews', endpoint: 'https://reviews.internal' };

function shell(overrides: Partial<ShellManifest> = {}): ShellManifest {
  return {
    id: 'storefront',
    framework: 'react',
    routes: [{ path: '/billing/*', layout: { areas: 'header header\nnav main' }, slots: { main: 'billing', nav: 'reviews' } }],
    ...overrides,
  };
}

describe('parseAreas', () => {
  it('reads ASCII art as grid areas with their spans', () => {
    const parsed = parseAreas('header header\nnav main');

    expect(parsed.errors).toEqual([]);
    expect(parsed.rowCount).toBe(2);
    expect(parsed.columnCount).toBe(2);
    expect(parsed.cells.flat()).toHaveLength(4);
    expect(parsed.areas).toEqual([
      { name: 'header', row: 1, column: 1, rowSpan: 1, columnSpan: 2 },
      { name: 'nav', row: 2, column: 1, rowSpan: 1, columnSpan: 1 },
      { name: 'main', row: 2, column: 2, rowSpan: 1, columnSpan: 1 },
    ]);
  });

  it('spans rows as well as columns', () => {
    const parsed = parseAreas('nav main\nnav main\nfoot foot');

    expect(parsed.areas.find((area) => area.name === 'nav')).toEqual({ name: 'nav', row: 1, column: 1, rowSpan: 2, columnSpan: 1 });
  });

  it('treats dots as empty cells, as CSS does', () => {
    const parsed = parseAreas('. header\n... main');

    expect(parsed.errors).toEqual([]);
    expect(parsed.cells).toEqual([
      ['.', 'header'],
      ['.', 'main'],
    ]);
    expect(parsed.areas.map((area) => area.name)).toEqual(['header', 'main']);
  });

  it('accepts rows pasted from CSS with their quotes, and ignores blank lines', () => {
    const parsed = parseAreas('"header header"\n\n  "nav main"  ');

    expect(parsed.errors).toEqual([]);
    expect(parsed.areas).toHaveLength(3);
  });

  it('rejects an L-shaped area, because CSS discards the whole template', () => {
    const parsed = parseAreas('nav main\nnav nav');

    expect(parsed.errors).toEqual([expect.stringContaining('"nav" is not a rectangle')]);
  });

  it('rejects an area split into two pieces', () => {
    const parsed = parseAreas('ad main ad');

    expect(parsed.errors).toEqual([expect.stringContaining('"ad" is not a rectangle')]);
  });

  it('rejects ragged rows and says which row', () => {
    const parsed = parseAreas('header header\nnav');

    expect(parsed.errors).toEqual([expect.stringContaining('row 2 has 1 cells but row 1 has 2')]);
  });

  it('rejects names CSS would not accept', () => {
    const parsed = parseAreas('1st main');

    expect(parsed.errors).toEqual([expect.stringContaining('"1st" is not a valid area name')]);
  });

  it('rejects an empty layout', () => {
    expect(parseAreas('  \n ').errors).toEqual([expect.stringContaining('empty')]);
  });

  it('formats cells back into aligned grid-template-areas strings', () => {
    expect(formatAreas(parseAreas('header header\nnav main').cells)).toEqual(['"header header"', '"nav    main"']);
  });
});

describe('isSafeAssetUrl', () => {
  it.each([
    ['https://cdn.example.com/a.js', true],
    ['/assets/app.css', true],
    ['http://cdn.example.com/a.js', false],
    ['//cdn.example.com/a.js', false],
    ['javascript:alert(1)', false],
    ['data:text/javascript,alert(1)', false],
    ['', false],
    ['/\t/evil.com/x.js', false],
    ['/\n/evil.com', false],
    ['/\r/evil.com', false],
    [' https://cdn.example.com/a.js', false],
    ['https://cdn.example.com/a\u2028.js', false],
    ['HTTPS://cdn.example.com/a.js', true],
  ])('%j → %s', (url, safe) => {
    expect(isSafeAssetUrl(url)).toBe(safe);
  });
});

describe('validateRegistry with shells', () => {
  const codes = (shells: ShellManifest[], manifests = [billing, reviews]) =>
    validateRegistry(manifests, { shells }).map((finding) => finding.code);

  it('accepts a valid shell', () => {
    expect(validateRegistry([billing, reviews], { shells: [shell()] })).toEqual([]);
  });

  it('behaves exactly as before when given no shells', () => {
    expect(validateRegistry([billing, reviews])).toEqual(validateRegistry([billing, reviews], {}));
  });

  it('reports a duplicate shell id', () => {
    expect(codes([shell(), shell()])).toEqual(['duplicate-shell-id']);
  });

  it('reports an invalid shell id and an unknown framework', () => {
    expect(codes([shell({ id: 'a/b', framework: 'svelte' as never })])).toEqual(['invalid-shell-id', 'invalid-shell-framework']);
  });

  it('reports a layout that is not a valid template', () => {
    expect(codes([shell({ routes: [{ path: '/x', layout: { areas: 'nav main\nnav nav' } }] })])).toEqual(['invalid-shell-layout']);
  });

  it('refuses track lists that could escape their CSS declaration', () => {
    const findings = validateRegistry([billing], {
      shells: [shell({ routes: [{ path: '/x', layout: { areas: 'main', columns: '1fr; } body { display: none' } }] })],
    });

    expect(findings.map((finding) => finding.code)).toEqual(['invalid-shell-layout']);
    expect(findings[0]?.message).toContain('columns');
  });

  it('reports a slot whose area the layout lacks', () => {
    expect(codes([shell({ routes: [{ path: '/x', layout: { areas: 'main' }, slots: { aside: 'billing' } }] })])).toEqual(['slot-unknown-area']);
  });

  it('reports a slotted fragment that is not registered, naming the shell', () => {
    const findings = validateRegistry([reviews], { shells: [shell()] });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'slot-unknown-fragment',
        severity: 'error',
        shellIds: ['storefront'],
        fragmentIds: ['billing'],
        message: expect.stringContaining('shell "storefront"'),
      }),
    ]);
  });

  it('reports invalid and repeated route paths', () => {
    expect(codes([shell({ routes: [{ path: 'billing', layout: { areas: 'main' } }] })])).toEqual(['invalid-route-path']);
    expect(
      codes([
        shell({
          routes: [
            { path: '/a', layout: { areas: 'main' } },
            { path: '/a', layout: { areas: 'main' } },
          ],
        }),
      ]),
    ).toEqual(['invalid-route-path']);
  });

  it.each(['javascript:alert(1)', 'data:text/javascript,1', 'http://cdn.example.com/a.js'])('refuses a script from %s', (src) => {
    expect(codes([shell({ head: { scripts: [{ src }] } })])).toEqual(['unsafe-shell-url']);
  });

  it('refuses an unsafe stylesheet URL', () => {
    expect(codes([shell({ head: { stylesheets: [{ href: 'javascript:x' }] } })])).toEqual(['unsafe-shell-url']);
  });

  it('refuses a track list that would open a CSS comment', () => {
    expect(isSafeTrackList('calc(100% / 3) 1fr')).toBe(true);
    expect(isSafeTrackList('1fr /*')).toBe(false);
    expect(isSafeTrackList('*/ 1fr')).toBe(false);
    expect(codes([shell({ routes: [{ path: '/x', layout: { areas: 'main', columns: '1fr /*' } }] })])).toEqual(['invalid-shell-layout']);
  });

  it('refuses shell ids outside a charset safe in files, classes, comments and URLs', () => {
    expect(codes([shell({ id: 'x--!><script>' })])).toEqual(['invalid-shell-id']);
    expect(codes([shell({ id: 'partner-portal.v2_b' })])).toEqual([]);
  });

  it('refuses route paths with whitespace or line separators', () => {
    expect(codes([shell({ routes: [{ path: "/a\u2028fetch('//evil')//", layout: { areas: 'main' } }] })])).toEqual(['invalid-route-path']);
  });

  it('reports a malformed shell instead of crashing on it', () => {
    const malformed = [
      { id: 'a', framework: 'react', routes: 'nope' },
      { id: 'b', framework: 'react', routes: [{ path: '/', layout: { areas: 7 } }] },
      { id: 'c', framework: 'react', routes: [], head: { title: {} } },
      { id: 'd', framework: 'react', routes: [], head: { scripts: [{ src: 'https://x.example/a.js', defer: 'yes' }] } },
      { id: 'e', framework: 'react', routes: [], head: { meta: [{ content: 'no name' }] } },
      { id: 'f', framework: 'react', routes: [{ path: '/', layout: { areas: 'main' }, slots: { main: 3 } }] },
    ] as unknown as ShellManifest[];

    expect(() => validateRegistry([billing], { shells: malformed })).not.toThrow();
    expect(validateRegistry([billing], { shells: malformed }).map((finding) => [finding.shellIds?.[0], finding.code])).toEqual(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => [id, 'invalid-shell-field']),
    );
  });
});

describe('parseAreas reserved names', () => {
  it('refuses __proto__, which a plain object cannot hold as a slot key', () => {
    expect(parseAreas('__proto__ main').errors).toEqual([expect.stringContaining('"__proto__" is not a valid area name')]);
  });

  it('reads CRLF input', () => {
    expect(parseAreas('header header\r\nnav main').errors).toEqual([]);
  });
});
