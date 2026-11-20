import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The renderer draws content an agent wrote. Its guarantee that no string becomes markup or code
 * rests on never using the APIs that turn one into the other — so their absence is checked here,
 * in every source file of the renderer and of the A2UI core, not left to review.
 */
const SINKS = [
  /\binnerHTML\b/,
  /\bouterHTML\b/,
  /\binsertAdjacentHTML\b/,
  /\bdocument\.write(ln)?\b/,
  /\bcreateContextualFragment\b/,
  /\bDOMParser\b/,
  /\bsrcdoc\b(?!['"])/,
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\bsetTimeout\s*\(\s*['"`]/,
  /\bsetInterval\s*\(\s*['"`]/,
];

const dirs = [import.meta.dirname, join(import.meta.dirname, '../a2ui')];
const sources = dirs.flatMap((dir) =>
  readdirSync(dir)
    .filter(
      (file) =>
        file.endsWith('.ts') &&
        !file.endsWith('.spec.ts') &&
        !file.endsWith('.spec-util.ts'),
    )
    .map((file) => ({
      file: join(dir, file),
      text: readFileSync(join(dir, file), 'utf8'),
    })),
);

describe('the renderer source', () => {
  it('is all here', () => {
    expect(sources.map((s) => s.file.split('/').pop())).toEqual(
      expect.arrayContaining([
        'dom.ts',
        'element.ts',
        'render.ts',
        'components.ts',
        'view.ts',
        'html.ts',
        'codec.ts',
      ]),
    );
  });

  it.each(
    sources.map((source) => [source.file.split('/src/')[1], source] as const),
  )('%s uses no string-to-markup or string-to-code API', (_name, source) => {
    // comments may name what the code must not do
    const code = source.text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const sink of SINKS)
      expect(code, `${source.file} matches ${sink}`).not.toMatch(sink);
  });
});
