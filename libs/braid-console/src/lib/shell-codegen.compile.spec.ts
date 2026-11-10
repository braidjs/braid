// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import ts from 'typescript';
import type { FragmentManifest } from '@braidlabs/gateway';
import type { ShellFramework, ShellManifest } from '@braidlabs/registry';
import { shellCode } from './shell-codegen.js';

/**
 * The generated React and Angular shells, type-checked by the compilers an application would use:
 * `tsc` with React's types, and the Angular compiler with strict templates. Parsing (the other
 * spec) cannot see a prop `<BraidFragment>` does not take or an import that does not exist.
 *
 * The files are written under the repository's `tmp/`, so their imports resolve as an app's would:
 * frameworks from `node_modules`, `@braidlabs/*` from source through the base tsconfig's paths.
 */

const repo = resolve(import.meta.dirname, '../../../..');
mkdirSync(join(repo, 'tmp'), { recursive: true });
const work = mkdtempSync(join(repo, 'tmp/shell-codegen-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const fragments: FragmentManifest[] = [
  { id: 'notifications', endpoint: 'https://n.internal', bound: false, src: '/inbox' },
  { id: 'billing', endpoint: 'https://b.internal', pierce: ['/orders/*'] },
  { id: 'reviews', endpoint: 'https://r.internal', pierce: ['/orders/*'] },
];

const shell: ShellManifest = {
  id: 'partner-portal',
  framework: 'react',
  routes: [
    {
      path: '/desk',
      layout: { areas: 'nav desk', columns: '220px 1fr', gap: '8px' },
      slots: { nav: 'reviews', desk: 'billing' },
      workspace: { area: 'desk', apps: ['billing', 'notifications', '"}<x>{{y}}`${z}'] },
    },
    { path: '/orders/*', layout: { areas: 'header\nmain', rows: '56px 1fr' }, slots: { header: 'notifications', main: 'billing' } },
    { path: '/', layout: { areas: 'main' }, slots: { main: 'billing' } },
  ],
  head: { title: 'Partner portal' },
};

interface Variant {
  /** Folder under the project. */
  folder: string;
  target: ShellFramework;
  edit?: (code: string) => string;
}

/** Writes each variant's source files and one tsconfig over all of them; returns the tsconfig's path. */
function project(name: string, variants: Variant[], compilerOptions: Record<string, unknown> = {}): string {
  const directory = join(work, name);
  const files: string[] = [];
  for (const { folder, target, edit = (code: string) => code } of variants) {
    const before = files.length;
    for (const file of shellCode(shell, fragments, target)) {
      // server.ts is a passage to paste into an existing Angular SSR server, not a module
      if ((file.language !== 'tsx' && file.language !== 'typescript') || file.name === 'server.ts') continue;
      const path = join(folder, file.name);
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), edit(file.code));
      files.push(path);
    }
    expect(files.length - before, `${target} source files`).toBeGreaterThanOrEqual(2);
  }
  const tsconfig = join(directory, 'tsconfig.json');
  writeFileSync(
    tsconfig,
    JSON.stringify({
      extends: join(repo, 'tsconfig.base.json'),
      compilerOptions: { noEmit: true, strict: true, target: 'es2022', lib: ['es2024', 'dom', 'dom.iterable'], types: [], rootDir: repo, ...compilerOptions },
      angularCompilerOptions: { strictTemplates: true, strictInjectionParameters: true },
      files,
    }),
  );
  return tsconfig;
}

const text = (diagnostics: readonly ts.Diagnostic[]) =>
  diagnostics
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => `${d.file ? `${d.file.fileName.slice(repo.length + 1)}: ` : ''}${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);

function typeCheck(tsconfig: string): string[] {
  const config = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(text([d]).join('\n')); } })!;
  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
  return text([...config.errors, ...ts.getPreEmitDiagnostics(program)]);
}

async function angularCheck(tsconfig: string): Promise<string[]> {
  const { performCompilation, readConfiguration } = await import('@angular/compiler-cli');
  const config = readConfiguration(tsconfig);
  const { diagnostics } = performCompilation({ rootNames: config.rootNames, options: config.options });
  return text([...config.errors, ...diagnostics]);
}

// One program per compiler: the shell as generated, and beside it a copy with one mistake, which
// must be the only thing reported. That the mistake is seen is what makes the silence mean something.
describe('generated shells, compiled', () => {
  const inWork = (errors: string[]) => errors.map((error) => error.replace(/^tmp\/shell-codegen-[^/]+\//, ''));

  it('react: type-checks with tsc and React types', () => {
    const tsconfig = project(
      'react',
      [
        { folder: 'app', target: 'react' },
        { folder: 'broken', target: 'react', edit: (code) => code.replace('<BraidFragment name={"reviews"}', '<BraidFragment nope={1} name={"reviews"}') },
      ],
      // a Vite application's own ambient types, which declare the `./shell-layout.css` import
      { jsx: 'react-jsx', types: ['vite/client'] },
    );
    const errors = inWork(typeCheck(tsconfig));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^react\/broken\/partner-portal\.tsx: .*'nope'/s);
  }, 120_000);

  it('angular and angular-ssr: compile with the Angular compiler and strict templates', async () => {
    const tsconfig = project('angular', [
      { folder: 'app', target: 'angular' },
      { folder: 'ssr', target: 'angular-ssr' },
      { folder: 'broken', target: 'angular', edit: (code) => code.replace('<braid-fragment name="reviews"', '<braid-fragment [nope]="1" name="reviews"') },
    ]);
    const errors = inWork(await angularCheck(tsconfig));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^angular\/broken\/partner-portal\.routes\.ts: Can't bind to 'nope'/);
  }, 180_000);
});
