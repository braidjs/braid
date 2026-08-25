import { DiscoveredProject } from './discovery.js';
import { DetanglePlan, Finding } from './plan.js';

/**
 * Checks that only make sense once the topology is known.
 *
 * Split from `buildPlan` because these are the ones that need to look at projects *other* than the
 * shell — who else consumes a remote, whether a remote's serve target actually serves a document —
 * and folding them into the mapping loop made that loop about two different things.
 */

/**
 * A fragment endpoint has to answer with **HTML**, not a `remoteEntry.js`.
 *
 * This is the difference between a remote that can be a fragment and one that only ever produced a
 * federation bundle. A `serve-static` target pointed at the MF output serves the bundle and a 404
 * for everything else, so the fragment's realm boot fails with a fetch error that reads like a
 * gateway misconfiguration and is not one.
 *
 * Detected structurally rather than by fetching: this command does not start servers.
 */
export function validateFragmentEndpoints(
  plan: DetanglePlan,
  projects: DiscoveredProject[],
): Finding[] {
  const findings: Finding[] = [];
  const byName = new Map(projects.map((project) => [project.name, project]));

  for (const fragment of plan.fragments) {
    const project = fragment.project ? byName.get(fragment.project) : undefined;
    if (!project) continue;

    if (project.serveCommand?.includes('serve-static')) {
      findings.push({
        level: 'block',
        message: `"${project.name}" is served by serve-static — a fragment endpoint must answer with a document`,
        fix: `use the app's normal serve target (nx serve ${project.name}), not a static serve of the federation bundle`,
      });
    }
  }

  return findings;
}

/**
 * Whether `--remove-mf` is safe: no *other* project still consumes these remotes.
 *
 * The plan calls for detecting this via the project graph and refusing with the list of other
 * consumers. Stripping the federation config out from under a second host is not recoverable by
 * re-running anything — that host simply stops building — so this is a refusal rather than a
 * warning, and it names every consumer so the developer can see the blast radius at once.
 */
export function checkRemoveModuleFederation(
  plan: DetanglePlan,
  projects: DiscoveredProject[],
): Finding[] {
  const shellName = plan.shell?.name;
  const converted = new Set(plan.fragments.map((fragment) => fragment.remote));

  const otherConsumers = projects.filter(
    (project) =>
      project.name !== shellName &&
      (project.mf?.remotes ?? []).some((remote) => converted.has(remote.name)),
  );

  if (otherConsumers.length === 0) return [];

  return [
    {
      level: 'block',
      message:
        `--remove-mf would break ${otherConsumers.length} other host${otherConsumers.length === 1 ? '' : 's'}: ` +
        otherConsumers.map((project) => project.name).join(', '),
      fix: 'convert them too, or leave the federation config in place — a monorepo mid-migration can have both',
    },
  ];
}

/**
 * Cross-remote deep imports: listed, never rewritten.
 *
 * `import { Thing } from 'billing/Thing'` in the shell has no Braid equivalent, because the whole
 * point of a realm is that the shell cannot hold a reference into the fragment's module graph. There
 * is no mechanical translation, so offering one would be worse than offering none.
 */
export function findDeepImports(source: string, file: string, remoteNames: string[]): Finding[] {
  const findings: Finding[] = [];
  const known = new Set(remoteNames);

  for (const match of source.matchAll(/^\s*import\s+(?:type\s+)?\{[^}]*\}\s+from\s+['"`]([\w$-]+)\/([^'"`]+)['"`]/gm)) {
    const remote = match[1]!;
    if (!known.has(remote)) continue;

    findings.push({
      level: 'warn',
      message: `${file}: imports ${remote}/${match[2]} directly`,
      fix:
        'a realm boundary has no equivalent — the shell cannot hold a reference into a fragment. ' +
        'Move the shared type to a library, or pass the value as a prop or context.',
    });
  }

  return findings;
}
