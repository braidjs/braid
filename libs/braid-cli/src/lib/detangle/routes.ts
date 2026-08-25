import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Where each remote is mounted in the shell — the `pierce` patterns.
 *
 * This answers open question 3 in the plan ("does detangle prompt per ambiguous route, or list
 * them as findings?") with: **list them**. A prompt is wrong here for a reason that outlives this
 * command — the answer belongs in `braid.config.json`, which is a reviewed file, and a value typed
 * at a prompt arrives in the repo with no record of who chose it or why. A finding that says "this
 * route mounts a remote and I could not tell at which path" is something a developer fixes once, in
 * a diff, with their reasoning in the commit.
 *
 * So: high-confidence call sites become `pierce` patterns, and everything else becomes a finding.
 * Nothing is inferred at medium confidence.
 */

export interface RemoteMount {
  /** The MF remote name, as the shell refers to it. */
  remote: string;
  /** Route path the remote is mounted at, when one could be read. */
  path?: string;
  /** Whether the shell mounted a routed module (bound) or an inline component (unbound). */
  kind: 'bound' | 'unbound' | 'unknown';
  /** Where this was found, relative to the workspace root. */
  file: string;
  /** Present when the mount was found but its path could not be read. */
  uncertain?: string;
}

const SOURCE = /\.(ts|tsx|js|jsx)$/;
const SKIP = new Set(['node_modules', 'dist', '.git', '.nx', 'tmp', 'coverage', '.angular']);

/** Scans a shell's sources for the ways a host mounts a federated remote. */
export async function findRemoteMounts(
  workspaceRoot: string,
  shellRoot: string,
  remoteNames: string[],
): Promise<RemoteMount[]> {
  const mounts: RemoteMount[] = [];
  const known = new Set(remoteNames);

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith('.')) await walk(path);
      } else if (SOURCE.test(entry.name)) {
        mounts.push(...scanSource(await readFile(path, 'utf-8'), relative(workspaceRoot, path), known));
      }
    }
  };

  await walk(join(workspaceRoot, shellRoot));
  return mounts;
}

export function scanSource(source: string, file: string, known: Set<string>): RemoteMount[] {
  const mounts: RemoteMount[] = [];
  const seen = new Set<string>();

  /**
   * `loadRemoteModule({ remoteName: 'billing', exposedModule: './Routes' })` and its positional
   * form, plus the bare `import('billing/Routes')` a native-federation shell uses.
   */
  const calls = [
    /loadRemoteModule\(\s*\{[^}]*?remoteName\s*:\s*['"`]([\w$-]+)['"`][^}]*?exposedModule\s*:\s*['"`]([^'"`]+)['"`]/gs,
    /loadRemoteModule\(\s*['"`]([\w$-]+)['"`]\s*,\s*['"`]([^'"`]+)['"`]/g,
    /import\(\s*['"`]([\w$-]+)\/([^'"`]+)['"`]\s*\)/g,
  ];

  for (const pattern of calls) {
    for (const match of source.matchAll(pattern)) {
      const remote = match[1]!;
      if (!known.has(remote)) continue;

      const exposed = match[2] ?? '';
      const kind = looksRouted(exposed) ? 'bound' : 'unbound';
      const path = routePathNear(source, match.index ?? 0);

      const key = `${remote}:${path ?? ''}:${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);

      mounts.push({
        remote,
        kind,
        file,
        ...(path === undefined ? {} : { path }),
        ...(path === undefined
          ? { uncertain: `mounts "${remote}" but its route path is not a string literal nearby` }
          : {}),
      });
    }
  }

  return mounts;
}

/**
 * An exposed module is *routed* if its name says so.
 *
 * A heuristic, and named as one. It decides `bound` vs `unbound`, which is the difference between
 * a fragment being asked for the page's own URL and being asked for one fixed path — and getting it
 * wrong produces a fragment that renders the wrong screen rather than one that fails. The plan's
 * output states the choice per remote so it can be corrected before `--write`.
 */
function looksRouted(exposedModule: string): boolean {
  return /routes?$|module$|^\.\/$|remote-entry/i.test(exposedModule.replace(/\.[jt]sx?$/, ''));
}

/**
 * Reads the `path:` of the route object a call site sits inside.
 *
 * Scoped to the 400 characters before the call, because a route array is written as a list of small
 * objects and the nearest preceding `path` is reliably the enclosing one. Beyond that window the
 * association stops being trustworthy, and an unreadable path is reported rather than assumed —
 * a wrong `pierce` puts a fragment on someone else's page.
 */
function routePathNear(source: string, index: number): string | undefined {
  const window = source.slice(Math.max(0, index - 400), index);
  const matches = [...window.matchAll(/path\s*:\s*(['"`])([^'"`]*)\1/g)];
  const last = matches.at(-1)?.[2];
  if (last === undefined) return undefined;
  return last.startsWith('/') ? last : `/${last}`;
}

/** Turns a route path into the pierce patterns a manifest wants. */
export function piercePatterns(path: string): string[] {
  const base = path.replace(/\/+$/, '') || '/';
  return base === '/' ? ['/', '/*'] : [base, `${base}/*`];
}
