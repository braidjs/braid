import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSdui } from '../lib/cli.js';
import { parseCatalog } from '../lib/catalog.js';
import { parseClientManifest } from '../lib/manifest.js';
import { a2uiCatalogId } from './capabilities.js';
import { parseA2uiStream } from './messages.js';
import { type PrerenderIndex, selectPrerendered } from './prerender.js';
import { upstreamValidators } from './upstream.spec-util.js';
import { a2uiCatalogFor } from './capabilities.js';

const dir = join(import.meta.dirname, '../../conformance/a2ui');
const disk = (path: string) => readFileSync(join(dir, path), 'utf8');

/** The command, over the real fixtures and an output directory in memory. */
function prerender(extra: string[] = [], out = new Map<string, string>()) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writes: string[] = [];
  const code = runSdui(
    [
      'a2ui',
      'prerender',
      '--catalog',
      'concierge.catalog.json',
      '--screen',
      'screens/trip.json',
      ...['current', 'current-patch', 'one-behind', 'legacy'].flatMap((m) => [
        '--manifest',
        `manifests/${m}.json`,
      ]),
      '--out',
      'out',
      ...extra,
    ],
    {
      readFile: (path) => {
        if (out.has(path)) return out.get(path) as string;
        if (path.startsWith('out/')) throw new Error('ENOENT');
        return disk(path);
      },
      writeFile: (path, content) => {
        writes.push(path);
        out.set(path, content);
      },
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  );
  return {
    code,
    out,
    writes,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
  };
}

const catalog = parseCatalog(JSON.parse(disk('concierge.catalog.json')));
const manifest = (name: string) =>
  parseClientManifest(JSON.parse(disk(`manifests/${name}.json`)));

describe('sdui a2ui prerender', () => {
  it('writes one stream and one page per variant, content-addressed, with an index', () => {
    const { code, out, stderr } = prerender();
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const index: PrerenderIndex = JSON.parse(
      out.get('out/index.json') as string,
    );
    const variants = index.screens['trip']!.variants;
    expect(variants.map((v) => v.outcome)).toEqual([
      'exact',
      'exact',
      'degraded',
      'fallback',
    ]);
    for (const variant of variants) {
      expect(variant.jsonl).toMatch(/^trip\/[0-9a-f]{20}\.jsonl$/);
      expect(variant.html).toMatch(/^trip\/[0-9a-f]{20}\.html$/);
      expect(out.has(`out/${variant.jsonl}`)).toBe(true);
      expect(out.has(`out/${variant.html}`)).toBe(true);
    }
    // two builds that draw alike share a catalog id and every file; the rest each have their own
    const [current, patch, behind, legacy] = variants;
    expect(patch!.catalogId).toBe(current!.catalogId);
    expect(patch!.jsonl).toBe(current!.jsonl);
    expect(patch!.html).toBe(current!.html);
    expect(new Set(variants.map((v) => v.jsonl)).size).toBe(3);
    expect(out.size).toBe(1 + 3 * 2);
    expect(legacy!.nodes).toMatchObject({ 'fallback-catalog': 2 });
    expect(behind!.catalogId).toBe(
      a2uiCatalogId(catalog, manifest('one-behind')),
    );
  });

  it('writes what that renderer receives: valid by the spec, at its versions', () => {
    const { out } = prerender();
    const index: PrerenderIndex = JSON.parse(
      out.get('out/index.json') as string,
    );
    for (const [name, variant] of [
      ['current', index.screens['trip']!.variants[0]],
      ['legacy', index.screens['trip']!.variants[3]],
    ] as const) {
      const messages = parseA2uiStream(
        out.get(`out/${variant!.jsonl}`) as string,
      );
      const validators = upstreamValidators(
        a2uiCatalogFor(catalog, manifest(name)),
      );
      for (const message of messages)
        expect(
          validators.agentToRenderer(message),
          validators.explain(validators.agentToRenderer),
        ).toBe(true);
      const html = out.get(`out/${variant!.html}`) as string;
      expect(html).toMatch(
        /^<a2ui-surface data-prerendered catalog-ids="[^"]+caps=cv_/,
      );
      expect(html).toContain('<h1>Lisbon, 3 nights</h1>');
      expect(html).toContain('Book this trip');
    }
    // the legacy page has the fare's stand-in, not the fare
    const legacy = out.get(
      `out/${index.screens['trip']!.variants[3]!.html}`,
    ) as string;
    expect(legacy).toContain('Return flight');
    expect(legacy).not.toContain('EUR');
    // the sale is behind a flag no one set
    expect(legacy).not.toContain('Summer sale');
  });

  it('a rerun writes nothing new', () => {
    const first = prerender();
    const again = prerender([], first.out);
    expect(again.code).toBe(0);
    expect(again.writes).toEqual([]);
    expect(again.stdout).toMatch(/0 written, 7 unchanged/);
  });

  it('prerenders each context as a variant of its own', () => {
    const { out, code } = prerender([
      '--context',
      'summer-sale=contexts/summer-sale.json',
    ]);
    expect(code).toBe(0);
    const index: PrerenderIndex = JSON.parse(
      out.get('out/index.json') as string,
    );
    const variant = selectPrerendered(
      index,
      'trip',
      [a2uiCatalogId(catalog, manifest('current'))],
      'summer-sale',
    );
    expect(variant?.context).toBe('summer-sale');
    expect(out.get(`out/${variant!.html}`)).toContain(
      'Summer sale: 20% off hotels',
    );
    // and the variant for everyone else is still there
    const plain = selectPrerendered(index, 'trip', [
      a2uiCatalogId(catalog, manifest('current')),
    ]);
    expect(plain?.context).toBeUndefined();
    expect(out.get(`out/${plain!.html}`)).not.toContain('Summer sale');
    expect(index.screens['trip']!.variants).toHaveLength(8);
  });

  it('selects the variant by the catalog ids a renderer supports, in its order', () => {
    const { out } = prerender();
    const index: PrerenderIndex = JSON.parse(
      out.get('out/index.json') as string,
    );
    const legacyId = a2uiCatalogId(catalog, manifest('legacy'));
    expect(
      selectPrerendered(index, 'trip', ['https://other.example/', legacyId])
        ?.outcome,
    ).toBe('fallback');
    expect(
      selectPrerendered(index, 'trip', ['https://other.example/']),
    ).toBeUndefined();
    expect(selectPrerendered(index, 'nope', [legacyId])).toBeUndefined();
  });

  it('refuses bad usage without writing anything', () => {
    const out = new Map<string, string>();
    const writes: string[] = [];
    const code = runSdui(
      [
        'a2ui',
        'prerender',
        '--catalog',
        'concierge.catalog.json',
        '--out',
        'out',
      ],
      {
        readFile: disk,
        writeFile: (path) => writes.push(path),
        stdout: () => undefined,
        stderr: () => undefined,
      },
    );
    expect(code).toBe(2);
    expect(writes).toEqual([]);
    expect(out.size).toBe(0);
  });
});
