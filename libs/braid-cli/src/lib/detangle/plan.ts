import { DiscoveredProject, inferShell } from './discovery.js';
import { RemoteMount, piercePatterns } from './routes.js';

/**
 * The detangle plan: what would change, and what a human has to decide.
 *
 * Kept as data rather than printed directly, so the report, the eventual `--write`, and the tests
 * all read the same thing. A command whose output is its product cannot have its output assembled
 * inside its printer.
 */

export type FindingLevel = 'block' | 'warn' | 'note';

export interface Finding {
  level: FindingLevel;
  message: string;
  /** What to do about it, when there is something to do. */
  fix?: string;
}

export interface PlannedFragment {
  id: string;
  remote: string;
  project?: string;
  port?: number;
  endpoint?: string;
  bound: boolean;
  pierce: string[];
  src?: string;
  serveCommand?: string;
  /** Where the mount was found, for the report. */
  from?: string;
}

export interface DetanglePlan {
  shell?: { name: string; root: string; port?: number; serveCommand?: string; hasServer: boolean };
  gateway: 'existing-server' | 'scaffold' | 'unknown';
  fragments: PlannedFragment[];
  findings: Finding[];
  /** True when nothing blocks a `--write`. */
  writable: boolean;
}

export interface BuildPlanInput {
  projects: DiscoveredProject[];
  mounts: RemoteMount[];
  requestedShell?: string;
}

export function buildPlan(input: BuildPlanInput): DetanglePlan {
  const findings: Finding[] = [];
  const shellResult = inferShell(input.projects, input.requestedShell);

  if ('ambiguous' in shellResult) {
    findings.push({
      level: 'block',
      message: `cannot choose a shell: ${shellResult.reason}`,
      fix:
        shellResult.ambiguous.length > 0
          ? `name one with --shell <project> (candidates: ${shellResult.ambiguous.join(', ')})`
          : 'detangle converts a Module Federation host — run it in a workspace that has one',
    });
    return { gateway: 'unknown', fragments: [], findings, writable: false };
  }

  const shell = shellResult.shell;
  const byName = new Map(input.projects.map((project) => [project.name, project]));
  const mountsByRemote = groupBy(input.mounts, (mount) => mount.remote);

  const fragments: PlannedFragment[] = [];

  for (const remote of shell.mf?.remotes ?? []) {
    const project = resolveRemoteProject(remote.name, input.projects);
    const mounts = mountsByRemote.get(remote.name) ?? [];
    const routed = mounts.find((mount) => mount.path !== undefined);
    const bound = mounts.some((mount) => mount.kind === 'bound') || mounts.length === 0;

    const fragment: PlannedFragment = {
      id: remote.name,
      remote: remote.name,
      bound,
      pierce: routed?.path ? piercePatterns(routed.path) : [],
      ...(project ? { project: project.name } : {}),
      ...(project?.port === undefined ? {} : { port: project.port }),
      ...(project?.port === undefined ? {} : { endpoint: `http://localhost:${project.port}` }),
      ...(project?.serveCommand ? { serveCommand: project.serveCommand } : {}),
      ...(routed?.file ? { from: routed.file } : {}),
    };

    if (!bound) fragment.src = routed?.path ?? '/';

    fragments.push(fragment);

    if (!project) {
      findings.push({
        level: 'block',
        message: `remote "${remote.name}" has no project in this workspace`,
        fix: remote.entry
          ? `it is configured as ${remote.entry} — a remote outside the workspace needs its endpoint in braid.config.json by hand`
          : 'check the remote name against the workspace, or add its endpoint by hand',
      });
    } else if (project.port === undefined) {
      findings.push({
        level: 'warn',
        message: `"${project.name}" has no serve port — its endpoint cannot be inferred`,
        fix: `set a port on its serve target, or fill in "endpoint" for "${remote.name}" after writing`,
      });
    }

    if (mounts.length === 0) {
      findings.push({
        level: 'warn',
        message: `no call site found for remote "${remote.name}" in ${shell.root}`,
        fix: 'it may be mounted dynamically — set its "pierce" patterns by hand',
      });
    }

    for (const mount of mounts.filter((mount) => mount.uncertain)) {
      findings.push({
        level: 'warn',
        message: `${mount.file}: ${mount.uncertain}`,
        fix: `set "pierce" for "${remote.name}" by hand`,
      });
    }
  }

  // Two fragments claiming the same page is legitimate — that is composition — but it is also
  // exactly what a mis-read route looks like, so it is surfaced either way.
  for (const [pattern, ids] of groupBy(
    fragments.flatMap((fragment) => fragment.pierce.map((pattern) => ({ pattern, id: fragment.id }))),
    (entry) => entry.pattern,
  )) {
    if (ids.length > 1) {
      findings.push({
        level: 'note',
        message: `${ids.map((entry) => entry.id).join(' and ')} both pierce ${pattern}`,
        fix: 'intentional if the page composes both — otherwise one of the route paths was misread',
      });
    }
  }

  if (shell.mf?.confidence === 'partial') {
    for (const note of shell.mf.notes) {
      findings.push({ level: 'warn', message: `${shell.mf.file}: ${note}` });
    }
  }

  /**
   * `shared` is the honest hard part, and the plan's scope section is explicit that no codemod can
   * decide what replaces it. Reported in full, converted never.
   */
  const shared = shell.mf?.shared ?? [];
  if (shared.length > 0) {
    findings.push({
      level: 'note',
      message: `${shared.length} shared singleton${shared.length === 1 ? '' : 's'}: ${shared.join(', ')}`,
      fix: 'shared instances do not survive realm isolation — move cross-app state onto the context bus',
    });
  }

  if (!shell.hasServer) {
    findings.push({
      level: 'note',
      message: `"${shell.name}" has no server target — a gateway app would be scaffolded`,
      fix: 'a client-rendered shell still composes, but fragments will not be in the first response',
    });
  }

  const writable = !findings.some((finding) => finding.level === 'block');

  return {
    shell: {
      name: shell.name,
      root: shell.root,
      ...(shell.port === undefined ? {} : { port: shell.port }),
      ...(shell.serveCommand ? { serveCommand: shell.serveCommand } : {}),
      hasServer: shell.hasServer,
    },
    gateway: shell.hasServer ? 'existing-server' : 'scaffold',
    fragments,
    findings,
    writable,
  };
}

/**
 * Matches a remote's MF name to a workspace project.
 *
 * MF names and Nx project names usually agree, and where they do not it is almost always because
 * the MF name is the project name with dashes removed. Both are tried; nothing else is guessed.
 */
function resolveRemoteProject(remoteName: string, projects: DiscoveredProject[]): DiscoveredProject | undefined {
  const byMfName = projects.find((project) => project.mf?.name === remoteName);
  if (byMfName) return byMfName;

  const normalize = (value: string) => value.replace(/[-_]/g, '').toLowerCase();
  return projects.find(
    (project) => project.name === remoteName || normalize(project.name) === normalize(remoteName),
  );
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

/** The `braid.config.json` this plan would write. Built here so a test can assert it without IO. */
export function toBraidConfig(plan: DetanglePlan, port = 4000): Record<string, unknown> {
  return {
    port,
    shell: {
      ...(plan.shell?.port === undefined ? {} : { port: plan.shell.port }),
      ...(plan.shell?.serveCommand ? { command: plan.shell.serveCommand } : {}),
    },
    fragments: plan.fragments.map((fragment) => ({
      id: fragment.id,
      ...(fragment.endpoint ? { endpoint: fragment.endpoint } : {}),
      ...(fragment.pierce.length > 0 ? { pierce: fragment.pierce } : {}),
      ...(fragment.bound ? {} : { bound: false, src: fragment.src ?? '/' }),
      ...(fragment.port === undefined && !fragment.serveCommand
        ? {}
        : {
            dev: {
              ...(fragment.port === undefined ? {} : { port: fragment.port }),
              ...(fragment.serveCommand ? { command: fragment.serveCommand } : {}),
            },
          }),
    })),
  };
}
