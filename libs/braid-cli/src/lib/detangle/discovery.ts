import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { MF_CONFIG_FILES, ModuleFederationConfig, parseModuleFederationConfig } from './mf-config.js';

/**
 * Finding the projects, without `@nx/devkit`.
 *
 * The plan called for `nx graph --file=…`, and that would be more authoritative. It also means
 * shelling out to a tool that may be a different version than the workspace expects, on a command
 * whose first job is to be safe to run. Scanning for `project.json` gets the same answer for every
 * layout Nx actually produces, needs no dependency, and — the reason it matters here — cannot fail
 * in a way that leaves a half-read graph looking like a complete one.
 *
 * Where this is weaker than the graph is implicit dependencies and non-Nx workspaces. Both are
 * reported rather than guessed at.
 */

export interface DiscoveredProject {
  name: string;
  /** Relative to the workspace root. */
  root: string;
  /** The project's dev port, from its serve target. */
  port?: number;
  /** The command that serves it, reconstructed for `braid.config.json`. */
  serveCommand?: string;
  /** Whether it has a server/SSR target — decides if a gateway needs scaffolding. */
  hasServer: boolean;
  mf?: ModuleFederationConfig;
}

/** Directories never worth walking into. */
const SKIP = new Set(['node_modules', 'dist', '.git', '.nx', 'tmp', 'coverage', '.angular']);

export async function discoverProjects(workspaceRoot: string): Promise<DiscoveredProject[]> {
  const found: DiscoveredProject[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((entry) => entry.isFile() && entry.name === 'project.json')) {
      const project = await readProject(workspaceRoot, dir);
      if (project) found.push(project);

      /**
       * Nx projects do not nest, so a project directory is a leaf — **except the workspace root**,
       * which is very often a project itself (a root `project.json` carrying workspace-wide targets).
       * Treating that as a leaf ends the scan immediately and reports a twenty-project monorepo as
       * having one project, which looks like "no Module Federation here" rather than like a bug.
       */
      if (dir !== workspaceRoot) return;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP.has(entry.name) && !entry.name.startsWith('.')) {
        await walk(join(dir, entry.name), depth + 1);
      }
    }
  };

  await walk(workspaceRoot, 0);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

async function readProject(workspaceRoot: string, dir: string): Promise<DiscoveredProject | undefined> {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(await readFile(join(dir, 'project.json'), 'utf-8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const root = relative(workspaceRoot, dir) || '.';
  const name = typeof config['name'] === 'string' ? config['name'] : root.split('/').pop()!;
  const targets = (config['targets'] ?? {}) as Record<string, { options?: Record<string, unknown> }>;

  const serve = targets['serve'] ?? targets['serve-static'];
  const port = readPort(serve?.options);

  return {
    name,
    root,
    ...(port === undefined ? {} : { port }),
    ...(serve ? { serveCommand: `nx serve ${name}` } : {}),
    /**
     * An SSR/server target is what decides whether detangle would scaffold a gateway app or insert
     * middleware into a server that already exists. `@angular/ssr` shows up as a `server` target;
     * a hand-rolled express server usually shows up as `serve-ssr` or a `server.ts` in the root.
     */
    hasServer: Boolean(targets['server'] ?? targets['serve-ssr'] ?? targets['server-build']),
    ...(await readModuleFederation(dir, workspaceRoot)),
  };
}

function readPort(options: Record<string, unknown> | undefined): number | undefined {
  const port = options?.['port'];
  return typeof port === 'number' ? port : undefined;
}

async function readModuleFederation(
  dir: string,
  workspaceRoot: string,
): Promise<{ mf?: ModuleFederationConfig }> {
  for (const filename of MF_CONFIG_FILES) {
    const path = join(dir, filename);
    try {
      if (!(await stat(path)).isFile()) continue;
    } catch {
      continue;
    }

    const source = await readFile(path, 'utf-8');
    const parsed = parseModuleFederationConfig(source, relative(workspaceRoot, path));
    // A webpack config with no federation block is just a webpack config; keep looking.
    if (parsed.confidence === 'none' && parsed.remotes.length === 0 && Object.keys(parsed.exposes).length === 0) {
      continue;
    }
    return { mf: parsed };
  }
  return {};
}

/**
 * Picks the shell: the project that consumes remotes and exposes nothing.
 *
 * Ambiguity is a prompt, not a coin flip — so this returns *why* it could not decide, and the
 * command asks for `--shell`. A workspace with two hosts is a normal thing to have, and guessing
 * which one to convert would be the single most expensive wrong answer this command could give.
 */
export function inferShell(
  projects: DiscoveredProject[],
  requested?: string,
): { shell: DiscoveredProject } | { ambiguous: string[]; reason: string } {
  if (requested) {
    const match = projects.find((project) => project.name === requested);
    if (match) return { shell: match };
    return { ambiguous: projects.map((p) => p.name), reason: `no project named "${requested}"` };
  }

  const hosts = projects.filter((project) => (project.mf?.remotes.length ?? 0) > 0);

  if (hosts.length === 0) {
    return { ambiguous: [], reason: 'no project declares Module Federation `remotes`' };
  }

  const pure = hosts.filter((project) => Object.keys(project.mf?.exposes ?? {}).length === 0);
  if (pure.length === 1) return { shell: pure[0]! };
  if (hosts.length === 1) return { shell: hosts[0]! };

  return {
    ambiguous: hosts.map((project) => project.name),
    reason: `${hosts.length} projects declare remotes`,
  };
}
