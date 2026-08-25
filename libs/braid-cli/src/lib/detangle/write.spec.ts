import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiscoveredProject } from './discovery.js';
import { buildPlan } from './plan.js';
import { DetangleRefusal, applyPlan, dirtyFiles, previewWrite } from './write.js';

const run = promisify(execFile);

/**
 * The refusals are the feature.
 *
 * `--write` edits a workspace, and its whole safety story is that `git checkout` undoes it. These
 * tests are less about the file that gets written than about the three cases where it must not be.
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

/** A plan that cannot be written: its remote has no project. */
const blockedPlan = () =>
  buildPlan({
    projects: [
      project('shell', {
        port: 4200,
        mf: {
          name: 'shell',
          remotes: [{ name: 'missing' }],
          exposes: {},
          shared: [],
          confidence: 'exact',
          notes: [],
          file: 'apps/shell/module-federation.config.ts',
        },
      }),
    ],
    mounts: [],
  });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'braid-write-'));
  await mkdir(join(root, 'apps'), { recursive: true });
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'test'], { cwd: root });
  await writeFile(join(root, 'nx.json'), '{}');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-qm', 'init'], { cwd: root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('applyPlan()', () => {
  it('writes braid.config.json on a clean tree', async () => {
    const result = await applyPlan({ workspaceRoot: root, plan: plan(), force: false });

    expect(result.written).toEqual(['braid.config.json']);
    const written = JSON.parse(await readFile(join(root, 'braid.config.json'), 'utf-8'));
    expect(written).toMatchObject({
      port: 4000,
      shell: { port: 4200, command: 'nx serve shell' },
      fragments: [{ id: 'billing', endpoint: 'http://localhost:4201' }],
    });
  });

  it('takes a port for the composed app', async () => {
    await applyPlan({ workspaceRoot: root, plan: plan(), force: false, port: 5000 });
    const written = JSON.parse(await readFile(join(root, 'braid.config.json'), 'utf-8'));
    expect(written.port).toBe(5000);
  });

  it('refuses on a dirty tree, and says which flag overrides it', async () => {
    await writeFile(join(root, 'untracked.txt'), 'x');

    const error = await applyPlan({ workspaceRoot: root, plan: plan(), force: false }).catch((e: unknown) => e);

    // The undo story is `git checkout`, which is only a story if there was nothing else to lose.
    expect(error).toBeInstanceOf(DetangleRefusal);
    expect((error as DetangleRefusal).message).toContain('uncommitted change');
    expect((error as DetangleRefusal).fix).toContain('--force');
  });

  it('writes on a dirty tree with --force', async () => {
    await writeFile(join(root, 'untracked.txt'), 'x');
    const result = await applyPlan({ workspaceRoot: root, plan: plan(), force: true });
    expect(result.written).toEqual(['braid.config.json']);
  });

  it('refuses when a finding blocks', async () => {
    const error = await applyPlan({ workspaceRoot: root, plan: blockedPlan(), force: false }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DetangleRefusal);
    expect((error as DetangleRefusal).message).toContain('block');
  });

  it('does not replace an existing config without being asked twice', async () => {
    await writeFile(join(root, 'braid.config.json'), '{ "shell": { "port": 9999 } }');
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', ['commit', '-qm', 'config'], { cwd: root });

    const result = await applyPlan({ workspaceRoot: root, plan: plan(), force: false });

    expect(result.written).toEqual([]);
    expect(result.skipped[0]?.reason).toContain('--force');
    // Untouched, not merged: a config someone wrote by hand is not this command's to edit.
    expect(await readFile(join(root, 'braid.config.json'), 'utf-8')).toContain('9999');
  });

  it('replaces an existing config with --force', async () => {
    await writeFile(join(root, 'braid.config.json'), '{ "shell": { "port": 9999 } }');
    const result = await applyPlan({ workspaceRoot: root, plan: plan(), force: true });

    expect(result.written).toEqual(['braid.config.json']);
    expect(await readFile(join(root, 'braid.config.json'), 'utf-8')).not.toContain('9999');
  });

  it('leaves a workspace outside git writable', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'braid-nogit-'));
    try {
      // Not a reason to refuse — plenty of workspaces are not repositories, and the guard is about
      // reversibility rather than about git. The command says so separately.
      expect(await dirtyFiles(bare)).toEqual([]);
      const result = await applyPlan({ workspaceRoot: bare, plan: plan(), force: false });
      expect(result.written).toEqual(['braid.config.json']);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe('previewWrite()', () => {
  it('returns the config that would be written', async () => {
    const preview = await previewWrite(root, plan());
    expect(JSON.parse(preview)).toMatchObject({ fragments: [{ id: 'billing' }] });
  });

  it('returns nothing when the file already matches', async () => {
    await applyPlan({ workspaceRoot: root, plan: plan(), force: false });
    expect(await previewWrite(root, plan())).toBe('');
  });
});
