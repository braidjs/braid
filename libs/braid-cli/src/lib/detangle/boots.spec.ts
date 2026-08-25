import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway } from '@braidlabs/gateway';
import { discoverProjects, inferShell } from './discovery.js';
import { findRemoteMounts } from './routes.js';
import { buildPlan } from './plan.js';
import { applyPlan } from './write.js';
import { detectFramework, planShellTransform } from './shell.js';
import { loadConfig } from '../config.js';

/**
 * The end of the pipeline: detangle a committed Module Federation workspace, then **boot what it
 * produced**.
 *
 * Every other test in this directory asserts what detangle *says*. This one asserts that what it
 * writes runs — the config is loaded by the same loader `braid dev` uses, a gateway is built from
 * it, and a request for `/billing` comes back with the remote's markup already inside the shell's
 * HTML.
 *
 * That last assertion is the one worth having. A conversion that produces a valid-looking config
 * and a page with an empty `<fragment-slot>` is the failure this whole command exists to avoid, and
 * it is invisible to every check that stops at the config file.
 */

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../tools/detangle-fixture');
const WORKSPACE_ROOT = resolve(FIXTURE, '../..');
const runCommand = promisify(execFile);

let workspace: string;
const servers: Server[] = [];

/** Serves one fixture app's `index.html` for every path, the way a dev server serves an SPA. */
function serveApp(name: string, port: number): Promise<Server> {
  return new Promise((resolveServer, reject) => {
    const server = createServer(async (request, response) => {
      try {
        const html = await readFile(join(workspace, 'apps', name, 'src', 'index.html'), 'utf-8');
        response.setHeader('content-type', 'text/html;charset=utf-8');
        response.end(html);
      } catch (error) {
        response.statusCode = 500;
        response.end(String(error));
      }
    });
    server.on('error', reject);
    server.listen(port, () => resolveServer(server));
  });
}

beforeAll(async () => {
  // Copied out, because the conversion writes braid.config.json and the fixture is committed.
  workspace = await mkdtemp(join(tmpdir(), 'braid-fixture-'));
  await cp(FIXTURE, workspace, { recursive: true });

  servers.push(await serveApp('billing', 4321), await serveApp('reviews', 4322));
}, 30_000);

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  await rm(workspace, { recursive: true, force: true });
});

async function detangleFixture() {
  const projects = await discoverProjects(workspace);
  const shell = inferShell(projects);
  if (!('shell' in shell)) throw new Error(shell.reason);

  const mounts = await findRemoteMounts(
    workspace,
    shell.shell.root,
    (shell.shell.mf?.remotes ?? []).map((remote) => remote.name),
  );
  return { projects, plan: buildPlan({ projects, mounts }) };
}

describe('the committed fixture', () => {
  it('is read as a Module Federation host with two routed remotes', async () => {
    const { plan, projects } = await detangleFixture();

    // The root project.json is deliberately present: it is the case that once ended the scan.
    expect(projects.map((project) => project.name)).toContain('fixture-root');
    expect(plan.shell?.name).toBe('shell');
    expect(plan.fragments.map((fragment) => fragment.id)).toEqual(['billing', 'reviews']);
    expect(plan.fragments[0]?.pierce).toEqual(['/billing', '/billing/*']);
    expect(plan.writable).toBe(true);
  });

  it('reports the shared singletons it will not convert', async () => {
    const { plan } = await detangleFixture();
    expect(plan.findings.some((finding) => finding.message.includes('@ngrx/store'))).toBe(true);
  });

  it('writes a config the real loader accepts', async () => {
    const { plan } = await detangleFixture();
    await applyPlan({ workspaceRoot: workspace, plan, force: true });

    const config = await loadConfig(join(workspace, 'braid.config.json'));
    expect(config.fragments.map((fragment) => fragment.id)).toEqual(['billing', 'reviews']);
  });
});

describe('the converted workspace boots', () => {
  it('composes the remote into the shell’s first response', async () => {
    const { plan } = await detangleFixture();
    await applyPlan({ workspaceRoot: workspace, plan, force: true });
    const config = await loadConfig(join(workspace, 'braid.config.json'));

    /**
     * The endpoints are re-pointed at the test's own servers because the fixture's declared ports
     * (4201/4202) are the ones a developer would run `nx serve` on — taking them here would make
     * this test fight anyone with the fixture running locally.
     */
    const gateway = createGateway({
      mode: 'development',
      registry: config.fragments.map((fragment) => ({
        id: fragment.id,
        endpoint: fragment.id === 'billing' ? 'http://localhost:4321' : 'http://localhost:4322',
        ...(fragment.pierce ? { pierce: fragment.pierce } : {}),
      })),
    });

    const shellHtml = await readFile(join(workspace, 'apps/shell/src/index.html'), 'utf-8');
    const composed = await gateway.handle(
      new Request('http://localhost:4000/billing', { headers: { accept: 'text/html' } }),
      async () => new Response(shellHtml, { headers: { 'content-type': 'text/html;charset=utf-8' } }),
    );

    // `handle` returns null for a request Braid does not own. A null here would mean the pierce
    // patterns detangle inferred never matched the route it inferred them from.
    expect(composed).not.toBeNull();
    const body = await composed!.text();

    // The claim: the fragment's markup is in the document before any JavaScript runs. A conversion
    // that yields an empty <fragment-slot> is exactly the failure this command exists to avoid, and
    // it is invisible to every check that stops at the config file.
    expect(composed!.status).toBe(200);
    expect(body).toContain('billing-root');
    expect(body).toContain('<h1>Shell</h1>');
  });

  it('serves the fragment’s own assets under its gateway namespace', async () => {
    const { plan } = await detangleFixture();
    await applyPlan({ workspaceRoot: workspace, plan, force: true });

    const gateway = createGateway({
      mode: 'development',
      registry: [{ id: 'billing', endpoint: 'http://localhost:4321' }],
    });

    const response = await gateway.handle(new Request('http://localhost:4000/__braid/frag/billing/'));

    // The namespace the shell's origin now answers for — the half of the conversion that makes a
    // fragment reachable at all.
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(await response!.text()).toContain('billing-root');
  });
});

describe('the codemods, end to end on the fixture', () => {
  it('removes the federated routes and leaves the rest of the file alone', async () => {
    const { plan } = await detangleFixture();
    const framework = await detectFramework(workspace, plan.shell!.root);
    const { edits } = await planShellTransform(workspace, plan, framework);

    await applyPlan({ workspaceRoot: workspace, plan, force: true, shell: true, shellEdits: edits });

    const routes = await readFile(join(workspace, 'apps/shell/src/app/app.routes.ts'), 'utf-8');
    expect(routes).not.toContain('billing');
    expect(routes).not.toContain('reviews');
    // Both federated routes gone; the file's own structure intact.
    expect(routes).toContain('export const routes');

    const config = await readFile(join(workspace, 'apps/shell/src/app/app.config.ts'), 'utf-8');
    expect(config).toContain(`import { provideBraid } from '@braidlabs/angular';`);
    expect(config).toContain('provideBraid(), ');
    expect(config).toContain('provideClientHydration(withIncrementalHydration()), ');

    // main.ts is left completely alone: the runtime is a provider, so app.config.ts is where it goes.
    const main = await readFile(join(workspace, 'apps/shell/src/main.ts'), 'utf-8');
    expect(main).toContain('bootstrapApplication(App, appConfig);');
    expect(main).not.toContain('@braidlabs');
  });

  it('scaffolds a gateway whose registry matches the config it wrote', async () => {
    const { plan } = await detangleFixture();
    await applyPlan({ workspaceRoot: workspace, plan, force: true, gateway: true });

    const config = JSON.parse(await readFile(join(workspace, 'braid.config.json'), 'utf-8'));
    const registry = JSON.parse(await readFile(join(workspace, 'apps/shell-gateway/src/registry.json'), 'utf-8'));

    // Two files that must agree, generated from one plan — the check that they actually do.
    expect(registry.map((entry: { id: string }) => entry.id)).toEqual(
      config.fragments.map((fragment: { id: string }) => fragment.id),
    );
    expect(registry[0].pierce).toEqual(config.fragments[0].pierce);

    const main = await readFile(join(workspace, 'apps/shell-gateway/src/main.ts'), 'utf-8');
    expect(main).toContain('toNodeMiddleware(createGateway(');
    expect(main).toContain("registry.json' with { type: 'json' }");
  });

  it('still composes after the shell has been converted', async () => {
    const { plan } = await detangleFixture();
    const framework = await detectFramework(workspace, plan.shell!.root);
    const { edits } = await planShellTransform(workspace, plan, framework);
    await applyPlan({ workspaceRoot: workspace, plan, force: true, shell: true, shellEdits: edits });

    const gateway = createGateway({
      mode: 'development',
      registry: [{ id: 'billing', endpoint: 'http://localhost:4321', pierce: ['/billing', '/billing/*'] }],
    });

    const shellHtml = await readFile(join(workspace, 'apps/shell/src/index.html'), 'utf-8');
    const composed = await gateway.handle(
      new Request('http://localhost:4000/billing', { headers: { accept: 'text/html' } }),
      async () => new Response(shellHtml, { headers: { 'content-type': 'text/html;charset=utf-8' } }),
    );

    // The whole pipeline, in one assertion: detangled, codemodded, and still composing. A route
    // removal that broke the shell would not show up in any earlier test.
    expect(composed).not.toBeNull();
    expect(await composed!.text()).toContain('billing-root');
  });
});

describe('the codemod output is valid TypeScript', () => {
  /**
   * Parsed with a real parser, not eyeballed.
   *
   * The first version of the shell transform inserted `provideClientHydration(…)` at line 1, above
   * the imports — output that looked plausible in a diff and did not parse. Every assertion about
   * *content* in this file would have passed on it. This is the one that would not have.
   */
  it.each([
    'apps/shell/src/app/app.config.ts',
    'apps/shell/src/app/app.routes.ts',
    'apps/shell/src/main.ts',
    'apps/shell-gateway/src/main.ts',
  ])('%s parses after conversion', async (file) => {
    const { plan } = await detangleFixture();
    const framework = await detectFramework(workspace, plan.shell!.root);
    const { edits } = await planShellTransform(workspace, plan, framework);
    await applyPlan({ workspaceRoot: workspace, plan, force: true, gateway: true, shell: true, shellEdits: edits });

    await expect(
      runCommand(resolve(WORKSPACE_ROOT, 'node_modules/.bin/esbuild'), [join(workspace, file), '--outfile=/dev/null']),
    ).resolves.toBeDefined();
  });
});
