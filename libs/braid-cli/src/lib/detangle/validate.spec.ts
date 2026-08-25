import { describe, expect, it } from 'vitest';
import type { DiscoveredProject } from './discovery.js';
import { buildPlan } from './plan.js';
import { checkRemoveModuleFederation, findDeepImports, validateFragmentEndpoints } from './validate.js';

function project(name: string, overrides: Partial<DiscoveredProject> = {}): DiscoveredProject {
  return { name, root: `apps/${name}`, hasServer: false, serveCommand: `nx serve ${name}`, ...overrides };
}

const mf = (remotes: string[], name = 'shell') => ({
  mf: {
    name,
    remotes: remotes.map((remote) => ({ name: remote })),
    exposes: {},
    shared: [],
    confidence: 'exact' as const,
    notes: [],
    file: `apps/${name}/module-federation.config.ts`,
  },
});

/**
 * `requestedShell` is passed explicitly because these fixtures deliberately contain a second host —
 * which is exactly the case `--remove-mf` exists to guard, and exactly the case `inferShell` refuses
 * to resolve on its own. A workspace with two hosts needs `--shell` before any of this applies.
 */
const plan = (projects: DiscoveredProject[]) =>
  buildPlan({
    projects,
    requestedShell: 'shell',
    mounts: [{ remote: 'billing', path: '/billing', kind: 'bound', file: 'apps/shell/src/app/app.routes.ts' }],
  });

describe('validateFragmentEndpoints()', () => {
  it('blocks a remote served by serve-static', () => {
    const projects = [
      project('shell', { ...mf(['billing']), port: 4200 }),
      project('billing', { port: 4201, serveCommand: 'nx serve-static billing' }),
    ];
    const findings = validateFragmentEndpoints(plan(projects), projects);

    // serve-static of the federation bundle answers with remoteEntry.js and 404s everything else —
    // the realm boot then fails with what reads like a gateway misconfiguration and is not one.
    expect(findings[0]?.level).toBe('block');
    expect(findings[0]?.fix).toContain('nx serve billing');
  });

  it('passes a remote with a normal serve target', () => {
    const projects = [project('shell', { ...mf(['billing']), port: 4200 }), project('billing', { port: 4201 })];
    expect(validateFragmentEndpoints(plan(projects), projects)).toEqual([]);
  });
});

describe('checkRemoveModuleFederation()', () => {
  it('refuses when another host still consumes a converted remote', () => {
    const projects = [
      project('shell', { ...mf(['billing']), port: 4200 }),
      project('billing', { port: 4201 }),
      project('admin', mf(['billing'], 'admin')),
    ];

    const findings = checkRemoveModuleFederation(plan(projects), projects);

    // Not recoverable by re-running anything: the other host simply stops building.
    expect(findings[0]?.level).toBe('block');
    expect(findings[0]?.message).toContain('admin');
  });

  it('allows removal when the shell is the only consumer', () => {
    const projects = [project('shell', { ...mf(['billing']), port: 4200 }), project('billing', { port: 4201 })];
    expect(checkRemoveModuleFederation(plan(projects), projects)).toEqual([]);
  });

  it('names every other consumer at once, not just the first', () => {
    const projects = [
      project('shell', { ...mf(['billing']), port: 4200 }),
      project('billing', { port: 4201 }),
      project('admin', mf(['billing'], 'admin')),
      project('ops', mf(['billing'], 'ops')),
    ];

    const message = checkRemoveModuleFederation(plan(projects), projects)[0]?.message ?? '';
    expect(message).toContain('admin');
    expect(message).toContain('ops');
  });
});

describe('findDeepImports()', () => {
  it('reports an import that reaches into a remote', () => {
    const findings = findDeepImports(
      `import { Invoice } from 'billing/Invoice';\nexport const x = 1;`,
      'apps/shell/src/app/app.routes.ts',
      ['billing'],
    );

    // A realm boundary has no equivalent — the shell cannot hold a reference into a fragment's
    // module graph — so there is no mechanical translation to offer.
    expect(findings[0]?.level).toBe('warn');
    expect(findings[0]?.message).toContain('billing/Invoice');
    expect(findings[0]?.fix).toContain('prop or context');
  });

  it('reports a type-only import too', () => {
    // Erased at build time, so it works today — and stops working the moment someone needs a value.
    const findings = findDeepImports(`import type { Invoice } from 'billing/Invoice';`, 'r.ts', ['billing']);
    expect(findings).toHaveLength(1);
  });

  it('ignores imports from packages that are not remotes', () => {
    expect(findDeepImports(`import { map } from 'rxjs/operators';`, 'r.ts', ['billing'])).toEqual([]);
  });
});
