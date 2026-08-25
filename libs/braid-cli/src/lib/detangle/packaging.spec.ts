import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Peer-dependency hygiene, enforced statically.
 *
 * `@braidlabs/gateway` and `@braidlabs/registry` are *peer* dependencies of the CLI, so a workspace
 * can legitimately have one and not the other. With static imports in `bin.ts`, `braid detangle`
 * crashed with `ERR_MODULE_NOT_FOUND: @braidlabs/gateway` in a workspace with no gateway — naming a
 * package the user had no reason to think they needed, from a file they had never heard of
 * (`dev-server.js`).
 *
 * This was found by packing the library and installing it, not by any test. These two assertions are
 * the cheap regression guard: one static import added back to `bin.ts`, or one real import of the
 * gateway added to a detangle module, and the coupling returns silently — it would pass every other
 * test in this suite, because the repo has all the peers.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_SRC = resolve(HERE, '../..');

/**
 * Import specifiers in real `import`/`export … from` statements.
 *
 * Template literals are stripped first, and that is not a detail: `gateway.ts` *generates* a server
 * whose source begins with `import { createGateway } from '@braidlabs/gateway'`, and a line-anchored
 * regex reads those as imports of this file. The first version of this test failed on exactly that,
 * which is a fair warning about how much a scanner like this can be trusted — it is a guard against
 * a specific regression, not a module resolver.
 */
function staticImports(source: string): string[] {
  return [...stripTemplateLiterals(source).matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(
    (match) => match[1]!,
  );
}

/** Blanks the contents of backtick strings, preserving line structure so offsets stay readable. */
function stripTemplateLiterals(source: string): string {
  let output = '';
  let inTemplate = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === '\\') {
      output += inTemplate ? ' ' : char + (source[i + 1] ?? '');
      if (!inTemplate) i++;
      else i++;
      continue;
    }
    if (char === '`') {
      inTemplate = !inTemplate;
      output += ' ';
      continue;
    }
    output += inTemplate && char !== '\n' ? ' ' : char;
  }
  return output;
}

describe('detangle needs no peer dependency', () => {
  it('imports nothing from @braidlabs in its own module graph', async () => {
    const files = (await readdir(HERE)).filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'));
    expect(files.length).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const file of files) {
      const imports = staticImports(await readFile(join(HERE, file), 'utf-8'));
      for (const specifier of imports.filter((name) => name.startsWith('@braidlabs/'))) {
        offenders.push(`${file} imports ${specifier}`);
      }
    }

    // `gateway.ts` *generates* code containing `import { createGateway } …`, which is why this
    // matches real import statements rather than the string `@braidlabs`.
    expect(offenders).toEqual([]);
  });
});

describe('bin.ts loads commands lazily', () => {
  it('imports no command module statically', async () => {
    const source = await readFile(join(CLI_SRC, 'bin.ts'), 'utf-8');
    const offenders = staticImports(source).filter((specifier) => specifier.includes('/lib/'));

    // A static import here is what pulled `dev-server.js` — and the gateway — into every command.
    expect(offenders).toEqual([]);
  });

  it('resolves every advertised command through a dynamic import', async () => {
    const source = await readFile(join(CLI_SRC, 'bin.ts'), 'utf-8');

    for (const command of ['dev', 'init', 'add', 'detangle', 'registry']) {
      expect(source).toMatch(new RegExp(`${command}:\\s*async \\(\\) =>\\s*\\(await import\\(`));
    }
  });

  it('translates a missing peer into the package name and the install command', async () => {
    const source = await readFile(join(CLI_SRC, 'bin.ts'), 'utf-8');

    // Node's own message names the importing file, which for a peer is an internal module the user
    // has never seen. The difference between a two-minute fix and a bug report.
    expect(source).toContain(`Cannot find package '(@braidlabs`);
    expect(source).toContain('npm install ');
  });
});
