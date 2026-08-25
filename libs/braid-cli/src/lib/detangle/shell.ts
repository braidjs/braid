import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DetanglePlan } from './plan.js';

/**
 * Turning the shell into a host.
 *
 * This is the phase the plan's one design rule was written for — *detangle proposes; the developer
 * disposes* — because it is the only phase that edits code somebody wrote. Everything here therefore
 * produces an **edit description** rather than performing an edit: a file, a line, the text to
 * remove, the text to put there, and why. `--write` applies them; `--diff` prints them; a test
 * asserts them without a filesystem.
 *
 * The rule that shaped the rest: **an edit whose "before" cannot be located exactly is not made.**
 * A route array is easy to find and hard to rewrite correctly — guards, factories, nested children,
 * `providers` on the route object — and a codemod that half-rewrites one leaves a shell that neither
 * federates nor composes. Where the pattern is not exact, this reports the site and the intended
 * change and leaves the typing to a human who can see the surrounding code.
 */

export interface ShellEdit {
  /** Workspace-relative file. */
  file: string;
  /** 1-indexed line, when the site is known. */
  line?: number;
  kind: 'insert' | 'replace' | 'manual';
  /** What the edit achieves, in one line. */
  summary: string;
  /** The text to insert or the replacement, when this is automatable. */
  text?: string;
  /** Why, for the diff output and for the developer reading it later. */
  why: string;
}

export interface ShellTransform {
  edits: ShellEdit[];
  /** Things the shell needs that could not be located at all. */
  followUps: string[];
}

/**
 * Files a shell keeps its bootstrap in. `main.ts` is where `initBraid` belongs — before any slot
 * connects — and `main.server.ts` is where Angular's server bootstrap lives.
 */
const BOOTSTRAP_FILES = ['src/main.ts', 'src/main.tsx', 'src/index.tsx', 'src/bootstrap.ts'];

export async function planShellTransform(
  workspaceRoot: string,
  plan: DetanglePlan,
  framework: 'angular' | 'react' | 'unknown',
): Promise<ShellTransform> {
  const edits: ShellEdit[] = [];
  const followUps: string[] = [];
  const shellRoot = plan.shell?.root;
  if (!shellRoot) return { edits, followUps };

  const bootstrap = await firstExisting(workspaceRoot, shellRoot, BOOTSTRAP_FILES);

  if (bootstrap) {
    if (!/@braidlabs\/(core|angular|react)/.test(bootstrap.source)) {
      edits.push({
        file: bootstrap.file,
        line: 1,
        kind: 'insert',
        summary: 'initialize the Braid runtime',
        text:
          framework === 'angular'
            ? `import { provideBraid } from '@braidlabs/angular';`
            : framework === 'react'
              ? `import { initBraidReact } from '@braidlabs/react';`
              : `import { initBraid } from '@braidlabs/core';`,
        why: 'the <fragment-slot> element is registered by the runtime; a slot that connects before it does nothing',
      });
    }

    /**
     * Hydration, for Angular, is non-negotiable and is the first entry in the failure-modes doc.
     *
     * Without it Angular discards the server-rendered DOM and re-creates it — which destroys the
     * `<fragment-slot>` the gateway already filled and boots a second realm to fetch it again. The
     * symptom is a fragment that flashes and reloads, and it is the single most likely way a freshly
     * converted workspace looks broken.
     */
    if (framework === 'angular' && !/provideClientHydration/.test(bootstrap.source)) {
      const config = await firstExisting(workspaceRoot, shellRoot, ['src/app/app.config.ts', 'src/app/app.config.server.ts']);
      edits.push({
        file: config?.file ?? bootstrap.file,
        kind: config ? 'insert' : 'manual',
        summary: 'add provideClientHydration() to both bootstraps',
        ...(config ? { text: `provideClientHydration(withIncrementalHydration()),` } : {}),
        why:
          'without hydration Angular discards the server-rendered DOM, destroying the fragment-slot the ' +
          'gateway filled and booting a second realm to re-fetch it — the first entry in braid-failure-modes.md',
      });
    }
  } else {
    followUps.push(`no bootstrap file found under ${shellRoot}/src — add the Braid runtime import by hand`);
  }

  for (const fragment of plan.fragments) {
    if (!fragment.from) {
      followUps.push(`${fragment.id}: no call site found — add its <fragment-slot> by hand`);
      continue;
    }

    const source = await read(workspaceRoot, fragment.from);
    if (!source) continue;

    const line = lineOf(source, new RegExp(`remoteName\\s*:\\s*['"\`]${fragment.remote}['"\`]|['"\`]${fragment.remote}/`));

    /**
     * A routed remote's route is *removed*, not rewritten: once the fragment is pierced at that
     * path, the gateway serves it and a client route pointing at the old federated module would
     * shadow the composed page with a second, unfederated one.
     */
    edits.push({
      file: fragment.from,
      ...(line === undefined ? {} : { line }),
      kind: 'manual',
      summary: fragment.bound
        ? `remove the "${fragment.remote}" route — the gateway serves ${fragment.pierce[0] ?? 'it'} now`
        : `replace the "${fragment.remote}" mount with <fragment-slot name="${fragment.id}" src="${fragment.src ?? '/'}">`,
      why: fragment.bound
        ? 'a client route still pointing at the federated module would shadow the composed page'
        : 'an inline component mount becomes an unbound fragment, asked for one fixed path on every page',
    });
  }

  return { edits, followUps };
}

/** Guesses the shell's framework from its dependencies. Reported, never assumed silently. */
export async function detectFramework(
  workspaceRoot: string,
  shellRoot: string,
): Promise<'angular' | 'react' | 'unknown'> {
  for (const candidate of [`${shellRoot}/package.json`, 'package.json']) {
    const source = await read(workspaceRoot, candidate);
    if (!source) continue;
    if (/"@angular\/core"/.test(source)) return 'angular';
    if (/"react-dom"/.test(source)) return 'react';
  }

  const bootstrap = await firstExisting(workspaceRoot, shellRoot, BOOTSTRAP_FILES);
  if (bootstrap?.source.includes('@angular/')) return 'angular';
  if (bootstrap?.source.includes('react-dom')) return 'react';
  return 'unknown';
}

async function read(workspaceRoot: string, relative: string): Promise<string | undefined> {
  try {
    return await readFile(join(workspaceRoot, relative), 'utf-8');
  } catch {
    return undefined;
  }
}

async function firstExisting(
  workspaceRoot: string,
  shellRoot: string,
  candidates: string[],
): Promise<{ file: string; source: string } | undefined> {
  for (const candidate of candidates) {
    const file = `${shellRoot}/${candidate}`;
    const source = await read(workspaceRoot, file);
    if (source !== undefined) return { file, source };
  }
  return undefined;
}

function lineOf(source: string, pattern: RegExp): number | undefined {
  const lines = source.split('\n');
  const index = lines.findIndex((line) => pattern.test(line));
  return index >= 0 ? index + 1 : undefined;
}
