import { execFile } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DetanglePlan, toBraidConfig } from './plan.js';

const run = promisify(execFile);

/**
 * Applying a plan.
 *
 * The one design rule from the plan document — *detangle proposes; the developer disposes* — lives
 * here, as three refusals rather than as a warning in the output:
 *
 * 1. **A blocking finding stops the write.** Warnings never do.
 * 2. **A dirty git tree stops the write**, because the value of `--write` is that `git checkout`
 *    undoes it, and that is only true if there was nothing else to lose.
 * 3. **An existing `braid.config.json` is never overwritten** without being asked twice.
 *
 * Each is overridable with `--force`, and each says which flag would override it. A refusal that
 * does not name its own escape hatch is just an obstacle.
 */

export interface WriteResult {
  written: string[];
  skipped: Array<{ path: string; reason: string }>;
}

export interface WriteOptions {
  workspaceRoot: string;
  plan: DetanglePlan;
  force: boolean;
  /** Port for the composed application. */
  port?: number;
}

export class DetangleRefusal extends Error {
  constructor(
    message: string,
    readonly fix: string,
  ) {
    super(message);
    this.name = 'DetangleRefusal';
  }
}

export async function applyPlan(options: WriteOptions): Promise<WriteResult> {
  const { workspaceRoot, plan, force } = options;

  if (!plan.writable && !force) {
    const blocking = plan.findings.filter((finding) => finding.level === 'block');
    throw new DetangleRefusal(
      `${blocking.length} finding${blocking.length === 1 ? '' : 's'} block${blocking.length === 1 ? 's' : ''} this conversion`,
      'fix them, or re-run with --force to write the plan anyway',
    );
  }

  const dirty = await dirtyFiles(workspaceRoot);
  if (dirty.length > 0 && !force) {
    throw new DetangleRefusal(
      `the git tree has ${dirty.length} uncommitted change${dirty.length === 1 ? '' : 's'}`,
      'commit or stash first — the point of --write is that `git checkout` undoes it, ' +
        'which is only true if there is nothing else to lose. --force skips this check.',
    );
  }

  const configPath = join(workspaceRoot, 'braid.config.json');
  const written: string[] = [];
  const skipped: WriteResult['skipped'] = [];

  if ((await exists(configPath)) && !force) {
    skipped.push({ path: 'braid.config.json', reason: 'already exists — use --force to replace it' });
  } else {
    const config = toBraidConfig(plan, options.port ?? 4000);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    written.push('braid.config.json');
  }

  return { written, skipped };
}

/**
 * Uncommitted changes, or none when this is not a git repository.
 *
 * A workspace outside git is not a reason to refuse — plenty exist, and the guard is about
 * reversibility rather than about git specifically. It is a reason to say so, which the caller
 * does, so that nobody assumes a safety net that is not there.
 */
export async function dirtyFiles(workspaceRoot: string): Promise<string[]> {
  try {
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: workspaceRoot });
    return stdout.split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

export async function isGitRepository(workspaceRoot: string): Promise<boolean> {
  try {
    await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workspaceRoot });
    return true;
  } catch {
    return false;
  }
}

/**
 * The diff `--write` would produce for `braid.config.json`, as a preview.
 *
 * Deliberately whole-file rather than a line diff: the file is small, it is usually being created
 * rather than edited, and a codemod that cannot be read as a diff before it runs will not be run
 * twice.
 */
export async function previewWrite(workspaceRoot: string, plan: DetanglePlan, port = 4000): Promise<string> {
  const configPath = join(workspaceRoot, 'braid.config.json');
  const next = `${JSON.stringify(toBraidConfig(plan, port), null, 2)}\n`;

  if (!(await exists(configPath))) return next;

  const current = await readFile(configPath, 'utf-8');
  return current === next ? '' : next;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
