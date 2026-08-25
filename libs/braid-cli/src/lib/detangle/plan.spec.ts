import { describe, expect, it } from 'vitest';
import type { DiscoveredProject } from './discovery.js';
import { inferShell } from './discovery.js';
import { buildPlan, toBraidConfig } from './plan.js';
import { piercePatterns, scanSource } from './routes.js';
import type { RemoteMount } from './routes.js';

function project(name: string, overrides: Partial<DiscoveredProject> = {}): DiscoveredProject {
  return {
    name,
    root: `apps/${name}`,
    hasServer: false,
    serveCommand: `nx serve ${name}`,
    ...overrides,
  };
}

const shellMf = (remotes: string[], extra: Partial<NonNullable<DiscoveredProject['mf']>> = {}) => ({
  mf: {
    name: 'shell',
    remotes: remotes.map((name) => ({ name })),
    exposes: {},
    shared: [],
    confidence: 'exact' as const,
    notes: [],
    file: 'apps/shell/module-federation.config.ts',
    ...extra,
  },
});

describe('inferShell()', () => {
  it('picks the project that consumes remotes and exposes nothing', () => {
    const result = inferShell([project('shell', shellMf(['billing'])), project('billing')]);
    expect('shell' in result && result.shell.name).toBe('shell');
  });

  it('refuses to choose between two hosts', () => {
    // The single most expensive wrong answer this command could give, so it asks instead.
    const result = inferShell([project('shell-a', shellMf(['billing'])), project('shell-b', shellMf(['reviews']))]);

    expect('ambiguous' in result).toBe(true);
    expect('ambiguous' in result && result.ambiguous).toEqual(['shell-a', 'shell-b']);
  });

  it('takes an explicit --shell over inference', () => {
    const result = inferShell(
      [project('shell-a', shellMf(['billing'])), project('shell-b', shellMf(['reviews']))],
      'shell-b',
    );
    expect('shell' in result && result.shell.name).toBe('shell-b');
  });

  it('says so when nothing declares remotes', () => {
    const result = inferShell([project('api'), project('web')]);
    expect('ambiguous' in result && result.reason).toContain('no project declares');
  });
});

describe('buildPlan()', () => {
  const projects = [
    project('shell', { ...shellMf(['billing', 'reviews']), port: 4200 }),
    project('billing', { port: 4201 }),
    project('reviews', { port: 4202 }),
  ];

  const mounts: RemoteMount[] = [
    { remote: 'billing', path: '/billing', kind: 'bound', file: 'apps/shell/src/app/app.routes.ts' },
    { remote: 'reviews', path: '/reviews', kind: 'bound', file: 'apps/shell/src/app/app.routes.ts' },
  ];

  it('maps every remote to a fragment with its port and pierce patterns', () => {
    const plan = buildPlan({ projects, mounts });

    expect(plan.shell?.name).toBe('shell');
    expect(plan.fragments).toEqual([
      expect.objectContaining({ id: 'billing', port: 4201, bound: true, pierce: ['/billing', '/billing/*'] }),
      expect.objectContaining({ id: 'reviews', port: 4202, bound: true, pierce: ['/reviews', '/reviews/*'] }),
    ]);
    expect(plan.writable).toBe(true);
  });

  it('scaffolds a gateway when the shell has no server', () => {
    expect(buildPlan({ projects, mounts }).gateway).toBe('scaffold');
  });

  it('inserts middleware when the shell already has one', () => {
    const withServer = [project('shell', { ...shellMf(['billing']), port: 4200, hasServer: true }), project('billing', { port: 4201 })];
    expect(buildPlan({ projects: withServer, mounts }).gateway).toBe('existing-server');
  });

  it('blocks on a remote with no project in the workspace', () => {
    const plan = buildPlan({ projects: [projects[0]!, projects[1]!], mounts });

    expect(plan.writable).toBe(false);
    expect(plan.findings.find((f) => f.level === 'block')?.message).toContain('reviews');
  });

  it('warns rather than blocks when a route path could not be read', () => {
    const plan = buildPlan({
      projects,
      mounts: [
        mounts[0]!,
        {
          remote: 'reviews',
          kind: 'bound',
          file: 'apps/shell/src/app/app.routes.ts',
          uncertain: 'mounts "reviews" but its route path is not a string literal nearby',
        },
      ],
    });

    // A missing pierce is a field to fill in, not a reason to refuse — the developer can still
    // convert and edit one line.
    expect(plan.writable).toBe(true);
    expect(plan.findings.some((f) => f.level === 'warn' && f.message.includes('reviews'))).toBe(true);
  });

  it('reports shared singletons and converts none of them', () => {
    const plan = buildPlan({
      projects: [project('shell', { ...shellMf(['billing'], { shared: ['@ngrx/store', '@angular/core'] }), port: 4200 }), project('billing', { port: 4201 })],
      mounts: [mounts[0]!],
    });

    // The honest hard part of any real migration; pretending otherwise would make the command lie.
    const shared = plan.findings.find((f) => f.message.includes('shared singleton'));
    expect(shared?.message).toContain('@ngrx/store');
    expect(shared?.fix).toContain('context bus');
    expect(plan.writable).toBe(true);
  });

  it('notes two fragments claiming the same page without blocking', () => {
    const plan = buildPlan({
      projects,
      mounts: [
        { remote: 'billing', path: '/billing', kind: 'bound', file: 'r.ts' },
        { remote: 'reviews', path: '/billing', kind: 'bound', file: 'r.ts' },
      ],
    });

    expect(plan.findings.some((f) => f.message.includes('both pierce /billing'))).toBe(true);
    expect(plan.writable).toBe(true);
  });

  it('surfaces a partial MF read as a finding', () => {
    const plan = buildPlan({
      projects: [
        project('shell', { ...shellMf(['billing'], { confidence: 'partial', notes: ['a `remotes` entry is not a literal'] }), port: 4200 }),
        project('billing', { port: 4201 }),
      ],
      mounts: [mounts[0]!],
    });

    expect(plan.findings.some((f) => f.message.includes('not a literal'))).toBe(true);
  });
});

describe('toBraidConfig()', () => {
  it('emits the config braid dev already understands', () => {
    const plan = buildPlan({
      projects: [
        project('shell', { ...shellMf(['billing']), port: 4200 }),
        project('billing', { port: 4201 }),
      ],
      mounts: [{ remote: 'billing', path: '/billing', kind: 'bound', file: 'r.ts' }],
    });

    expect(toBraidConfig(plan)).toEqual({
      port: 4000,
      shell: { port: 4200, command: 'nx serve shell' },
      fragments: [
        {
          id: 'billing',
          endpoint: 'http://localhost:4201',
          pierce: ['/billing', '/billing/*'],
          dev: { port: 4201, command: 'nx serve billing' },
        },
      ],
    });
  });

  it('marks an inline component mount as unbound with a src', () => {
    const plan = buildPlan({
      projects: [
        project('shell', { ...shellMf(['notifications']), port: 4200 }),
        project('notifications', { port: 4203 }),
      ],
      mounts: [{ remote: 'notifications', path: '/panel', kind: 'unbound', file: 'shell.html.ts' }],
    });

    const fragment = (toBraidConfig(plan)['fragments'] as Array<Record<string, unknown>>)[0]!;
    expect(fragment['bound']).toBe(false);
    expect(fragment['src']).toBe('/panel');
  });
});

describe('scanSource()', () => {
  const known = new Set(['billing']);

  it('finds a loadRemoteModule call and the route it sits in', () => {
    const mounts = scanSource(
      `export const routes: Routes = [
         { path: 'billing', loadChildren: () => loadRemoteModule({ remoteName: 'billing', exposedModule: './Routes' }).then((m) => m.routes) },
       ];`,
      'app.routes.ts',
      known,
    );

    expect(mounts).toEqual([
      expect.objectContaining({ remote: 'billing', path: '/billing', kind: 'bound' }),
    ]);
  });

  it('finds the positional form', () => {
    const mounts = scanSource(
      `{ path: 'billing', loadChildren: () => loadRemoteModule('billing', './Routes') }`,
      'app.routes.ts',
      known,
    );
    expect(mounts[0]?.path).toBe('/billing');
  });

  it('finds a native-federation dynamic import', () => {
    const mounts = scanSource(`{ path: 'billing', loadChildren: () => import('billing/Routes') }`, 'r.ts', known);
    expect(mounts[0]).toMatchObject({ remote: 'billing', kind: 'bound' });
  });

  it('classifies a component mount as unbound', () => {
    const mounts = scanSource(
      `const Panel = () => loadRemoteModule({ remoteName: 'billing', exposedModule: './Panel' });`,
      'panel.ts',
      known,
    );
    expect(mounts[0]?.kind).toBe('unbound');
  });

  it('reports a mount whose path is not a literal, rather than inventing one', () => {
    const mounts = scanSource(
      `{ path: BILLING_PATH, loadChildren: () => loadRemoteModule({ remoteName: 'billing', exposedModule: './Routes' }) }`,
      'app.routes.ts',
      known,
    );

    // A wrong `pierce` puts a fragment on someone else's page, so an unreadable path is never
    // guessed at.
    expect(mounts[0]?.path).toBeUndefined();
    expect(mounts[0]?.uncertain).toContain('not a string literal');
  });

  it('ignores remotes it was not told about', () => {
    expect(scanSource(`loadRemoteModule({ remoteName: 'other', exposedModule: './Routes' })`, 'r.ts', known)).toEqual([]);
  });
});

describe('piercePatterns()', () => {
  it('covers the route and everything under it', () => {
    expect(piercePatterns('/billing')).toEqual(['/billing', '/billing/*']);
  });

  it('handles the root route', () => {
    expect(piercePatterns('/')).toEqual(['/', '/*']);
  });

  it('normalises a trailing slash', () => {
    expect(piercePatterns('/billing/')).toEqual(['/billing', '/billing/*']);
  });
});
