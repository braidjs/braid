import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiscoveredProject } from './discovery.js';
import { buildPlan } from './plan.js';
import { applyShellEdits, findRemovableRoute, planShellTransform } from './shell.js';
import { applyPlan } from './write.js';

const run = promisify(execFile);

/**
 * The codemods, and — mostly — what they refuse to do.
 *
 * Route removal is the only shell edit worth automating: it is mechanical, and forgetting it leaves
 * a client route shadowing the composed page. It is also the edit most able to destroy a file, so
 * the majority of these tests assert that a route is left alone.
 */

let root: string;

function project(name: string, overrides: Partial<DiscoveredProject> = {}): DiscoveredProject {
  return { name, root: `apps/${name}`, hasServer: false, serveCommand: `nx serve ${name}`, ...overrides };
}

const plan = () =>
  buildPlan({
    projects: [
      project('shell', {
        port: 4200,
        mf: {
          name: 'shell',
          remotes: [{ name: 'billing' }],
          exposes: {},
          shared: [],
          confidence: 'exact',
          notes: [],
          file: 'apps/shell/module-federation.config.ts',
        },
      }),
      project('billing', { port: 4201 }),
    ],
    mounts: [{ remote: 'billing', path: '/billing', kind: 'bound', file: 'apps/shell/src/app/app.routes.ts' }],
  });

async function write(path: string, contents: string): Promise<void> {
  const full = join(root, path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, contents);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'braid-codemod-'));
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 't@e.com'], { cwd: root });
  await run('git', ['config', 'user.name', 't'], { cwd: root });
  await write('apps/shell/package.json', JSON.stringify({ dependencies: { '@angular/core': '^22.0.0' } }));
  await write('apps/shell/src/main.ts', `import { bootstrapApplication } from '@angular/platform-browser';\nbootstrapApplication(App, appConfig);\n`);
  await write('apps/shell/src/app/app.config.ts', `export const appConfig = { providers: [provideRouter(routes)] };\n`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ROUTES = `import { loadRemoteModule } from '@nx/module-federation';

export const routes = [
  { path: 'home', component: Home },
  {
    path: 'billing',
    loadChildren: () => loadRemoteModule({ remoteName: 'billing', exposedModule: './Routes' }).then((m) => m.routes),
  },
  { path: '**', component: NotFound },
];
`;

describe('findRemovableRoute()', () => {
  /**
   * A character offset, which is what the function takes — a line number cannot tell "the object
   * opens above" from "the object opens later on this same line", and every single-line route in a
   * real routes file is the second case.
   */
  const callSite = (source: string) => source.indexOf('remoteName');

  it('finds the exact element of a plain route', () => {
    const range = findRemovableRoute(ROUTES, callSite(ROUTES))?.range;
    expect(range).toEqual({ from: 5, to: 8 });

    // The braces it identified really are the element's, and nothing else's.
    const element = ROUTES.split('\n').slice(range!.from - 1, range!.to).join('\n');
    expect(element.trim().startsWith('{')).toBe(true);
    expect(element.trim().endsWith('},')).toBe(true);
    expect(element).toContain('billing');
    expect(element).not.toContain('NotFound');
  });

  it.each([
    ['canActivate', `canActivate: [AuthGuard],`],
    ['canMatch', `canMatch: [FeatureFlag],`],
    ['resolve', `resolve: { user: UserResolver },`],
    ['providers', `providers: [BillingService],`],
    ['children', `children: [{ path: 'x', component: X }],`],
    ['data', `data: { title: 'Billing' },`],
  ])('refuses a route carrying %s', (_name, extra) => {
    const source = ROUTES.replace(`    path: 'billing',`, `    path: 'billing',\n    ${extra}`);

    // Each of these carries behaviour the fragment does not inherit, or routes unrelated to this
    // remote. Deleting the element silently drops them, and the bug surfaces in production.
    expect(findRemovableRoute(source, callSite(source))).toBeUndefined();
  });

  it('refuses when the element holds more than one route', () => {
    const source = `export const routes = [
  {
    path: 'billing',
    loadChildren: () => loadRemoteModule({ remoteName: 'billing', exposedModule: './Routes' }),
    path: 'duplicate',
  },
];`;
    expect(findRemovableRoute(source, callSite(source))).toBeUndefined();
  });

  it('refuses a route whose path is not a literal', () => {
    const source = ROUTES.replace(`path: 'billing',`, `path: BILLING_PATH,`);
    expect(findRemovableRoute(source, callSite(source))).toBeUndefined();
  });

  it('finds a single-line route element too', () => {
    // The shape the committed fixture uses, and the one the first implementation refused outright.
    const source = `export const routes = [
  { path: 'home', component: Home },
  { path: 'billing', loadChildren: () => loadRemoteModule({ remoteName: 'billing', exposedModule: './Routes' }) },
  { path: '**', component: NotFound },
];`;
    expect(findRemovableRoute(source, callSite(source))?.range).toEqual({ from: 3, to: 3 });
  });

  it('is not fooled by a brace inside a string', () => {
    const source = `export const routes = [
  { path: 'billing/{id}', loadChildren: () => loadRemoteModule({ remoteName: 'billing', exposedModule: './Routes' }) },
];`;
    // The forward scan is string-aware, and the range it returns is re-verified to enclose the
    // anchor — so a mis-scan refuses rather than deleting the wrong span.
    expect(findRemovableRoute(source, callSite(source))?.range).toEqual({ from: 2, to: 2 });
  });

  it('refuses when the braces do not balance', () => {
    const source = `export const routes = [
  { path: 'billing', loadChildren: () => loadRemoteModule({ remoteName: 'billing', exposedModule: './Routes' })
];`;
    expect(findRemovableRoute(source, callSite(source))).toBeUndefined();
  });
});

describe('applyShellEdits()', () => {
  it('removes the route and leaves every other line byte-identical', async () => {
    await write('apps/shell/src/app/app.routes.ts', ROUTES);
    const { edits } = await planShellTransform(root, plan(), 'angular');

    await applyShellEdits(root, edits);
    const after = await readFile(join(root, 'apps/shell/src/app/app.routes.ts'), 'utf-8');

    expect(after).not.toContain('billing');
    // The reason this is line-based and not an AST rewrite: everything else is untouched, so the
    // result reads as a diff. A codemod that reformats 300 lines to change 2 gets reviewed by nobody.
    expect(after).toContain(`{ path: 'home', component: Home },`);
    expect(after).toContain(`{ path: '**', component: NotFound },`);
    expect(after).toContain(`import { loadRemoteModule } from '@nx/module-federation';`);
  });

  it('wires the runtime into the providers array, not just the imports', async () => {
    await write('apps/shell/src/app/app.routes.ts', ROUTES);
    const { edits } = await planShellTransform(root, plan(), 'angular');

    await applyShellEdits(root, edits);
    const config = await readFile(join(root, 'apps/shell/src/app/app.config.ts'), 'utf-8');

    expect(config).toContain(`import { provideBraid } from '@braidlabs/angular';`);
    // The bug this replaced: the first version inserted a bare `provideClientHydration(…)` at line
    // 1, above the imports, producing TypeScript that does not parse.
    expect(config).toContain('providers: [provideClientHydration(withIncrementalHydration()), provideBraid(), provideRouter(routes)]');
    expect(config.split('\n').every((line) => !/^provide\w+\(/.test(line))).toBe(true);
  });

  it('produces a config file that still parses', async () => {
    await write('apps/shell/src/app/app.routes.ts', ROUTES);
    const { edits } = await planShellTransform(root, plan(), 'angular');
    await applyShellEdits(root, edits);

    const config = await readFile(join(root, 'apps/shell/src/app/app.config.ts'), 'utf-8');

    // Cheap structural proof: every import is still at the top, and the braces balance.
    const lines = config.split('\n').filter((line) => line.trim());
    const lastImport = lines.reduce((last, line, i) => (line.startsWith('import ') ? i : last), -1);
    const firstNonImport = lines.findIndex((line) => !line.startsWith('import '));
    expect(lastImport).toBeLessThan(firstNonImport === -1 ? lines.length : firstNonImport);
    expect((config.match(/\[/g) ?? []).length).toBe((config.match(/\]/g) ?? []).length);
  });

  it('skips manual edits rather than guessing at them', async () => {
    const guarded = ROUTES.replace(`    path: 'billing',`, `    path: 'billing',\n    canActivate: [AuthGuard],`);
    await write('apps/shell/src/app/app.routes.ts', guarded);
    const { edits } = await planShellTransform(root, plan(), 'angular');

    const result = await applyShellEdits(root, edits);
    const after = await readFile(join(root, 'apps/shell/src/app/app.routes.ts'), 'utf-8');

    expect(after).toContain('billing');
    expect(after).toContain('AuthGuard');
    expect(result.skipped.some((skip) => skip.path.endsWith('app.routes.ts'))).toBe(true);
  });

  it('says why a route was left manual', async () => {
    const guarded = ROUTES.replace(`    path: 'billing',`, `    path: 'billing',\n    canActivate: [AuthGuard],`);
    await write('apps/shell/src/app/app.routes.ts', guarded);

    const { edits } = await planShellTransform(root, plan(), 'angular');
    const route = edits.find((edit) => edit.summary.includes('billing'));

    expect(route?.kind).toBe('manual');
    expect(route?.why).toContain('canActivate');
  });

  it('applies several edits to one file without shifting each other', async () => {
    // Two inserts into one file: applied bottom-up, so the first does not move the second's line.
    const result = await applyShellEdits(root, [
      { file: 'apps/shell/src/main.ts', line: 1, kind: 'insert', text: '// first', summary: 'a', why: 'w' },
      { file: 'apps/shell/src/main.ts', line: 2, kind: 'insert', text: '// second', summary: 'b', why: 'w' },
    ]);

    expect(result.written).toEqual(['apps/shell/src/main.ts']);
    const lines = (await readFile(join(root, 'apps/shell/src/main.ts'), 'utf-8')).split('\n');
    expect(lines[0]).toBe('// first');
    expect(lines[2]).toBe('// second');
  });
});

describe('applyPlan() with the new writes', () => {
  it('writes only the config unless the extra flags are given', async () => {
    await write('apps/shell/src/app/app.routes.ts', ROUTES);
    const result = await applyPlan({ workspaceRoot: root, plan: plan(), force: true });

    // `--write` alone stays what it has always been: one file nobody wrote.
    expect(result.written).toEqual(['braid.config.json']);
    expect(await readFile(join(root, 'apps/shell/src/app/app.routes.ts'), 'utf-8')).toContain('billing');
  });

  it('scaffolds the gateway app when asked', async () => {
    const result = await applyPlan({ workspaceRoot: root, plan: plan(), force: true, gateway: true });

    expect(result.written).toContain('apps/shell-gateway/src/main.ts');
    expect(result.written).toContain('apps/shell-gateway/src/registry.json');
    const registry = JSON.parse(await readFile(join(root, 'apps/shell-gateway/src/registry.json'), 'utf-8'));
    expect(registry[0]).toMatchObject({ id: 'billing', pierce: ['/billing', '/billing/*'] });
  });

  it('refuses an existing gateway directory wholesale', async () => {
    await write('apps/shell-gateway/src/main.ts', 'export const mine = true;\n');
    // Committed first, so the dirty-tree guard does not fire ahead of the one under test — it
    // otherwise refuses earlier, which is correct behaviour and the wrong thing to be asserting.
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', ['commit', '-qm', 'existing gateway'], { cwd: root });

    const result = await applyPlan({ workspaceRoot: root, plan: plan(), force: false, gateway: true });

    // Half a gateway app — a new main.ts beside somebody's existing project.json — is the state a
    // developer is least equipped to untangle, because they did not choose it.
    expect(result.skipped.some((skip) => skip.path.startsWith('apps/shell-gateway'))).toBe(true);
    expect(await readFile(join(root, 'apps/shell-gateway/src/main.ts'), 'utf-8')).toContain('mine');
  });

  it('applies shell edits when asked', async () => {
    await write('apps/shell/src/app/app.routes.ts', ROUTES);
    const { edits } = await planShellTransform(root, plan(), 'angular');

    await applyPlan({ workspaceRoot: root, plan: plan(), force: true, shell: true, shellEdits: edits });

    expect(await readFile(join(root, 'apps/shell/src/app/app.routes.ts'), 'utf-8')).not.toContain('billing');
  });

  it('still refuses everything on a dirty tree', async () => {
    await write('apps/shell/src/app/app.routes.ts', ROUTES);
    await writeFile(join(root, 'stray.txt'), 'x');

    await expect(
      applyPlan({ workspaceRoot: root, plan: plan(), force: false, gateway: true, shell: true }),
    ).rejects.toThrow(/uncommitted/);

    // Nothing partial: the refusal happens before any write, not between them.
    expect(await readdir(root)).not.toContain('braid.config.json');
  });
});
