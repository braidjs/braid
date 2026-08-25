import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiscoveredProject } from './discovery.js';
import { buildPlan } from './plan.js';
import { findMiddlewareInsertion, scaffoldGatewayApp } from './gateway.js';
import { detectFramework, planShellTransform } from './shell.js';

let root: string;

async function write(path: string, contents: string): Promise<void> {
  const full = join(root, path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, contents);
}

function project(name: string, overrides: Partial<DiscoveredProject> = {}): DiscoveredProject {
  return { name, root: `apps/${name}`, hasServer: false, serveCommand: `nx serve ${name}`, ...overrides };
}

const plan = (hasServer = false) =>
  buildPlan({
    projects: [
      project('shell', {
        port: 4200,
        hasServer,
        mf: {
          name: 'shell',
          remotes: [{ name: 'billing' }, { name: 'notifications' }],
          exposes: {},
          shared: [],
          confidence: 'exact',
          notes: [],
          file: 'apps/shell/module-federation.config.ts',
        },
      }),
      project('billing', { port: 4201 }),
      project('notifications', { port: 4203 }),
    ],
    mounts: [
      { remote: 'billing', path: '/billing', kind: 'bound', file: 'apps/shell/src/app/app.routes.ts' },
      { remote: 'notifications', path: '/panel', kind: 'unbound', file: 'apps/shell/src/app/header.ts' },
    ],
  });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'braid-transform-'));

  await write('apps/shell/package.json', JSON.stringify({ dependencies: { '@angular/core': '^22.0.0' } }));
  await write('apps/shell/src/main.ts', `import { bootstrapApplication } from '@angular/platform-browser';\nbootstrapApplication(App, appConfig);\n`);
  await write('apps/shell/src/app/app.config.ts', `export const appConfig = { providers: [provideRouter(routes)] };\n`);
  await write(
    'apps/shell/src/app/app.routes.ts',
    `export const routes = [\n  { path: 'billing', loadChildren: () => loadRemoteModule({ remoteName: 'billing', exposedModule: './Routes' }) },\n];\n`,
  );
  await write(
    'apps/shell/src/app/header.ts',
    `export const Panel = () => loadRemoteModule({ remoteName: 'notifications', exposedModule: './Panel' });\n`,
  );

  // A second shell that already has a server, for the middleware path.
  await write(
    'apps/ssr-shell/src/server.ts',
    `import express from 'express';\nconst app = express();\napp.use(express.static('dist'));\napp.listen(4000);\n`,
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('detectFramework()', () => {
  it('reads the framework from the shell package.json', async () => {
    expect(await detectFramework(root, 'apps/shell')).toBe('angular');
  });

  it('says unknown rather than guessing', async () => {
    expect(await detectFramework(root, 'apps/ssr-shell')).toBe('unknown');
  });
});

describe('planShellTransform()', () => {
  it('adds the runtime import *and* its provider call, in the file with the providers', async () => {
    const { edits } = await planShellTransform(root, plan(), 'angular');

    /**
     * Both halves, or neither. An import without its call is an unused import and a runtime that
     * never initializes — which is worse than making no edit, because it looks done.
     */
    const importEdit = edits.find((edit) => edit.summary === 'import the Braid runtime');
    const callEdit = edits.find((edit) => edit.summary.includes('provideBraid() to the application'));

    expect(importEdit?.file).toBe('apps/shell/src/app/app.config.ts');
    expect(importEdit?.text).toContain('@braidlabs/angular');
    expect(callEdit?.text).toBe('provideBraid(), ');
    // A character offset, because `providers: [ … ]` is written on one line as often as not.
    expect(callEdit?.offset).toBeGreaterThan(0);
  });

  it('leaves the runtime manual when there is no providers array to insert into', async () => {
    const { edits } = await planShellTransform(root, plan(), 'react');
    const runtime = edits.find((edit) => edit.summary.includes('initBraidReact'));

    expect(runtime?.kind).toBe('manual');
    expect(runtime?.why).toContain('providers');
  });

  it('adds hydration for an Angular shell that lacks it', async () => {
    const { edits } = await planShellTransform(root, plan(), 'angular');
    const hydration = edits.find((edit) => edit.summary.includes('provideClientHydration'));

    // The first entry in the failure-modes doc: without it, Angular discards the server-rendered
    // DOM and boots a second realm to re-fetch what the gateway already delivered.
    expect(hydration).toBeDefined();
    expect(hydration?.file).toBe('apps/shell/src/app/app.config.ts');
    expect(hydration?.why).toContain('second realm');
  });

  it('does not add hydration for a React shell', async () => {
    const { edits } = await planShellTransform(root, plan(), 'react');
    expect(edits.some((edit) => edit.summary.includes('provideClientHydration'))).toBe(false);
  });

  it('says to remove a bound remote’s route, and why', async () => {
    const { edits } = await planShellTransform(root, plan(), 'angular');
    const billing = edits.find((edit) => edit.summary.includes('billing'));

    expect(billing?.summary).toContain('remove');
    expect(billing?.file).toBe('apps/shell/src/app/app.routes.ts');
    expect(billing?.line).toBe(2);
    // A client route still pointing at the federated module would shadow the composed page.
    expect(billing?.why).toContain('shadow');
  });

  it('says to replace an unbound remote’s mount with a slot', async () => {
    const { edits } = await planShellTransform(root, plan(), 'angular');
    const notifications = edits.find((edit) => edit.summary.includes('notifications'));

    expect(notifications?.summary).toContain('fragment-slot name="notifications"');
    expect(notifications?.summary).toContain('src="/panel"');
  });

  it('marks a plain route removable and an inline mount manual', async () => {
    const { edits } = await planShellTransform(root, plan(), 'angular');

    /**
     * The line the whole phase turns on. A plain `{ path, loadChildren: loadRemoteModule(…) }` is
     * mechanical and gets a range; an inline component mount becomes markup nobody can generate
     * without seeing the template, so it stays manual. Guarded routes are covered in
     * `codemod.spec.ts`, which is where the refusals live.
     */
    const billing = edits.find((edit) => edit.summary.includes('billing'));
    expect(billing?.kind).toBe('remove');
    expect(billing?.range).toBeDefined();

    const notifications = edits.find((edit) => edit.summary.includes('notifications'));
    expect(notifications?.kind).toBe('manual');
    expect(notifications?.range).toBeUndefined();
  });
});

describe('scaffoldGatewayApp()', () => {
  it('generates a server, a registry, and a project', () => {
    const scaffold = scaffoldGatewayApp(plan());

    expect(Object.keys(scaffold.files).sort()).toEqual([
      'apps/shell-gateway/project.json',
      'apps/shell-gateway/src/main.ts',
      'apps/shell-gateway/src/registry.json',
    ]);
  });

  it('carries every fragment into the generated registry', () => {
    const scaffold = scaffoldGatewayApp(plan());
    const registry = JSON.parse(scaffold.files['apps/shell-gateway/src/registry.json']!);

    expect(registry).toEqual([
      { id: 'billing', endpoint: 'http://localhost:4201', pierce: ['/billing', '/billing/*'] },
      { id: 'notifications', endpoint: 'http://localhost:4203', pierce: ['/panel', '/panel/*'], bound: false, src: '/panel' },
    ]);
  });

  it('warns that a client-rendered shell loses first-paint composition', () => {
    const scaffold = scaffoldGatewayApp(plan());
    expect(scaffold.followUps.some((note) => note.includes('first response'))).toBe(true);
  });
});

describe('findMiddlewareInsertion()', () => {
  it('finds the first app.use in an existing server', async () => {
    const insertion = await findMiddlewareInsertion(root, 'apps/ssr-shell');

    expect(insertion?.file).toBe('apps/ssr-shell/src/server.ts');
    // Before the static handler: the gateway has to see a request before anything else answers it.
    expect(insertion?.line).toBe(3);
    expect(insertion?.snippet).toContain('toNodeMiddleware');
  });

  it('reports nothing when the shell has no server file', async () => {
    expect(await findMiddlewareInsertion(root, 'apps/shell')).toBeUndefined();
  });
});
