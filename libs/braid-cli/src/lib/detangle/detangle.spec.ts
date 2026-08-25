import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverProjects, inferShell } from './discovery.js';
import { findRemoteMounts } from './routes.js';
import { buildPlan, toBraidConfig } from './plan.js';
import { render } from './index.js';

/**
 * End to end against a real Module Federation workspace on disk.
 *
 * The unit tests above feed the planner data it was designed to receive; this one makes it go and
 * find that data itself, from files laid out the way Nx lays them out. Discovery is the phase the
 * whole command rests on — every later phase writes based on what this reads — so it is worth
 * exercising against a filesystem rather than against a fixture object.
 */

let root: string;

async function write(path: string, contents: string): Promise<void> {
  const full = join(root, path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, contents);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'braid-detangle-'));

  // A shell with three remotes: two routed, one mounted as an inline component.
  await write('nx.json', JSON.stringify({ npmScope: 'acme' }));
  await write('apps/shell/project.json', JSON.stringify({ name: 'shell', targets: { serve: { options: { port: 4200 } } } }));
  await write(
    'apps/shell/module-federation.config.ts',
    `import { ModuleFederationConfig } from '@nx/module-federation';
     const config: ModuleFederationConfig = {
       name: 'shell',
       remotes: ['billing', 'reviews', 'notifications'],
       shared: { '@ngrx/store': { singleton: true }, '@angular/core': { singleton: true } },
     };
     export default config;`,
  );
  await write(
    'apps/shell/src/app/app.routes.ts',
    `import { loadRemoteModule } from '@nx/module-federation';
     export const routes = [
       { path: 'billing', loadChildren: () => loadRemoteModule({ remoteName: 'billing', exposedModule: './Routes' }).then((m) => m.routes) },
       { path: 'reviews', loadChildren: () => loadRemoteModule({ remoteName: 'reviews', exposedModule: './Routes' }).then((m) => m.routes) },
     ];`,
  );
  await write(
    'apps/shell/src/app/header.ts',
    `import { loadRemoteModule } from '@nx/module-federation';
     export const Panel = () => loadRemoteModule({ remoteName: 'notifications', exposedModule: './Panel' });`,
  );

  for (const [name, port] of [
    ['billing', 4201],
    ['reviews', 4202],
  ] as const) {
    await write(`apps/${name}/project.json`, JSON.stringify({ name, targets: { serve: { options: { port } } } }));
    await write(
      `apps/${name}/module-federation.config.ts`,
      `export default { name: '${name}', exposes: { './Routes': 'apps/${name}/src/app/entry.routes.ts' } };`,
    );
  }

  // Deliberately has no serve target: detangle should warn, not block.
  await write('apps/notifications/project.json', JSON.stringify({ name: 'notifications', targets: { build: {} } }));
  await write(
    'apps/notifications/module-federation.config.ts',
    `export default { name: 'notifications', exposes: { './Panel': 'apps/notifications/src/app/panel.ts' } };`,
  );

  // Noise the scan must ignore: a library with no federation, and a node_modules copy of the shell.
  await write('libs/ui/project.json', JSON.stringify({ name: 'ui', targets: {} }));
  await write('node_modules/@acme/shell/project.json', JSON.stringify({ name: 'not-a-real-project' }));

  /**
   * A `project.json` at the workspace root, which is extremely common in Nx (workspace-wide
   * targets live there) and which broke the scan: a project directory is a leaf, so treating the
   * root as one ended the walk immediately. A twenty-project monorepo reported as one project reads
   * as "no Module Federation here" rather than as a bug, which is the worst way for this to fail.
   */
  await write('project.json', JSON.stringify({ name: 'workspace-root', targets: {} }));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function planFixture() {
  const projects = await discoverProjects(root);
  const shell = inferShell(projects);
  if (!('shell' in shell)) throw new Error(shell.reason);
  const mounts = await findRemoteMounts(root, shell.shell.root, shell.shell.mf!.remotes.map((r) => r.name));
  return { projects, mounts, plan: buildPlan({ projects, mounts }) };
}

describe('detangle against a real workspace', () => {
  it('finds every project and skips node_modules', async () => {
    const projects = await discoverProjects(root);

    expect(projects.map((project) => project.name)).toEqual([
      'billing',
      'notifications',
      'reviews',
      'shell',
      'ui',
      'workspace-root',
    ]);
    expect(projects.some((project) => project.name === 'not-a-real-project')).toBe(false);
  });

  it('infers the shell from the federation configs', async () => {
    const { plan } = await planFixture();
    expect(plan.shell).toMatchObject({ name: 'shell', root: 'apps/shell', port: 4200, hasServer: false });
  });

  it('maps routed remotes to bound fragments with their pierce patterns', async () => {
    const { plan } = await planFixture();

    expect(plan.fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'billing', port: 4201, bound: true, pierce: ['/billing', '/billing/*'] }),
        expect.objectContaining({ id: 'reviews', port: 4202, bound: true, pierce: ['/reviews', '/reviews/*'] }),
      ]),
    );
  });

  it('classifies an inline component mount as unbound', async () => {
    const { plan } = await planFixture();
    const notifications = plan.fragments.find((fragment) => fragment.id === 'notifications');

    // `./Panel` is not a routed module, so the fragment is chrome rather than a screen — and asking
    // its endpoint for `/billing/invoices` is a question it has no answer to.
    expect(notifications).toMatchObject({ bound: false });
  });

  it('warns about the remote with no serve port, and does not block on it', async () => {
    const { plan } = await planFixture();

    expect(plan.findings.some((f) => f.level === 'warn' && f.message.includes('notifications'))).toBe(true);
    expect(plan.writable).toBe(true);
  });

  it('reports the shared singletons it will not convert', async () => {
    const { plan } = await planFixture();
    const shared = plan.findings.find((f) => f.message.includes('shared singleton'));

    expect(shared?.message).toContain('@ngrx/store');
    expect(shared?.fix).toContain('context bus');
  });

  it('notes that the shell has no server, so a gateway would be scaffolded', async () => {
    const { plan } = await planFixture();
    expect(plan.gateway).toBe('scaffold');
    expect(plan.findings.some((f) => f.message.includes('no server target'))).toBe(true);
  });

  it('emits a braid.config.json that braid dev can already run', async () => {
    const { plan } = await planFixture();
    const config = toBraidConfig(plan) as { shell: unknown; fragments: Array<Record<string, unknown>> };

    expect(config.shell).toEqual({ port: 4200, command: 'nx serve shell' });
    expect(config.fragments.find((f) => f['id'] === 'billing')).toEqual({
      id: 'billing',
      endpoint: 'http://localhost:4201',
      pierce: ['/billing', '/billing/*'],
      dev: { port: 4201, command: 'nx serve billing' },
    });
  });

  it('renders a report naming every fragment and finding', async () => {
    const { plan, projects } = await planFixture();
    // The report is the product of this phase, so it is asserted rather than eyeballed.
    // Escapes are stripped by splitting on the character rather than matching it: a control
    // character inside a regex is exactly what `no-control-regex` exists to stop.
    const output = render(plan, projects.length)
      .split(String.fromCharCode(27))
      .map((part, index) => (index === 0 ? part : part.replace(/^\[\d+m/, '')))
      .join('');

    expect(output).toContain('apps/shell');
    expect(output).toContain('billing');
    expect(output).toContain('/billing /billing/*');
    expect(output).toContain('unbound');
    expect(output).toContain('Findings');
    expect(output).toContain('shared singleton');
  });
});
