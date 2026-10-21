import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FragmentManifest } from '@braidlabs/gateway';
import {
  accessMatrix,
  ANONYMOUS,
  createSnapshot,
  diffRegistries,
  fetchDescriptors,
  mergeDescriptors,
  parsePrincipal,
  parseObservations,
  parseSnapshot,
  routingImpact,
  validateRegistry,
  type AccessMatrix,
  type DescriptorNote,
  type FieldChange,
  type NamedPrincipal,
  type RegistryDiff,
  type RoutingImpact,
  type RegistryFinding,
} from '@braidlabs/registry';
import { fileSnapshotStore } from '@braidlabs/registry/node';
import { findConfig, loadConfig } from './config.js';

const BOLD = '[1m';
const DIM = '[2m';
const RED = '[31m';
const YELLOW = '[33m';
const GREEN = '[32m';
const CYAN = '[36m';
const RESET = '[0m';

export const REGISTRY_USAGE = `braid registry — inspect and publish the fragment registry

  braid registry validate                     check the local registry for conflicts
  braid registry diff --against <ref>         compare local config to a published snapshot
  braid registry publish --to <dir>           mint an immutable snapshot from local config
      --label <k=v>                             attribution, repeatable; not part of the id
      --descriptors                             merge each fragment's self-published descriptor
      --dry-run                                 compute the snapshot id without writing

  braid registry impact --observations <file> --against <ref>
                                              what a change does to traffic you actually serve
  braid registry access [--against <ref>]      who can list and load each fragment
      --as <spec>                               a principal to test, repeatable
                                                  name:roles=a,b;scopes=c   (bare name = holds nothing)

  <ref> is a snapshot file, a directory holding one, or an http(s) URL.
  Every command reads the registry from --config <path> (braid.config by default), or from
  --source <module>: a module whose default export is the manifest array or a function returning
  it — a supergraph([...]), say.

  Principals may also live in braid.config.json:
      "principals": { "trader": { "roles": ["trader"] }, "auditor": {} }
`;

/** `braid registry <subcommand>` */
export async function registry(argv: string[]): Promise<number> {
  const [subcommand, ...rest] = argv;

  switch (subcommand) {
    case 'validate':
      return validateCommand(rest);
    case 'diff':
      return diffCommand(rest);
    case 'publish':
      return publishCommand(rest);
    case 'access':
      return accessCommand(rest);
    case 'impact':
      return impactCommand(rest);
    default:
      process.stdout.write(REGISTRY_USAGE);
      return subcommand && subcommand !== '--help' && subcommand !== '-h' ? 1 : 0;
  }
}

/**
 * `braid registry validate` — everything decidable from the manifests alone.
 *
 * Cheap enough for CI, which is the point: a pierce-pattern conflict is invisible in a diff that
 * shows one changed line, and expensive to notice in production.
 */
async function validateCommand(argv: string[]): Promise<number> {
  const manifests = await localManifests(argv);
  if (!manifests) return 1;

  const findings = validateRegistry(manifests);
  process.stdout.write(formatFindings(findings, manifests.length));

  return findings.some((finding) => finding.severity === 'error') ? 1 : 0;
}

/**
 * `braid registry diff --against <ref>` — what this config would change about a published one.
 *
 * Changes are labelled with the field's owner, because a changed `pierce` is a routing change with
 * page-wide blast radius while a changed `title` is a label, and a flat list of altered keys makes
 * those look alike.
 */
async function diffCommand(argv: string[]): Promise<number> {
  const against = flag(argv, '--against');
  if (!against) {
    process.stderr.write('braid registry diff: --against <snapshot file, directory, or URL> is required\n');
    return 1;
  }

  const manifests = await localManifests(argv);
  if (!manifests) return 1;

  let published: FragmentManifest[];
  try {
    published = await loadReference(against);
  } catch (error) {
    process.stderr.write(`braid registry diff: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  process.stdout.write(formatDiff(diffRegistries(published, manifests), against));
  return 0;
}

/**
 * `braid registry publish --to <dir>` — mint a snapshot from local config.
 *
 * Refuses on validation errors. Publishing a registry that cannot serve is not a useful artifact,
 * and the snapshot model makes the refusal cheap: nothing has been written, so nothing needs
 * undoing.
 */
async function publishCommand(argv: string[]): Promise<number> {
  let manifests = await localManifests(argv);
  if (!manifests) return 1;

  let descriptorNotes: DescriptorNote[] = [];
  if (argv.includes('--descriptors')) {
    const merged = mergeDescriptors(manifests, await fetchDescriptors(manifests));
    manifests = merged.manifests;
    descriptorNotes = merged.notes;
    process.stdout.write(formatDescriptorNotes(descriptorNotes));
  }

  const findings = validateRegistry(manifests);
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (errors.length > 0) {
    process.stdout.write(formatFindings(findings, manifests.length));
    process.stderr.write('braid registry publish: refusing to publish a registry with errors\n');
    return 1;
  }

  const snapshot = await createSnapshot({ manifests, labels: parseLabels(argv) });
  const dryRun = argv.includes('--dry-run');
  const directory = flag(argv, '--to');

  if (!dryRun && !directory) {
    process.stderr.write('braid registry publish: --to <directory> is required (or pass --dry-run)\n');
    return 1;
  }

  if (!dryRun) {
    const store = fileSnapshotStore({ directory: resolve(process.cwd(), directory!) });
    await store.put(snapshot);
    await store.setHead?.(snapshot.id);
  }

  const warnings = findings.filter((finding) => finding.severity === 'warning');
  process.stdout.write(
    `${warnings.length > 0 ? formatFindings(findings, manifests.length) + '\n' : ''}` +
      `${BOLD}${snapshot.id}${RESET}${dryRun ? ` ${DIM}(dry run — nothing written)${RESET}` : ''}\n` +
      `${DIM}  ${manifests.length} fragment${manifests.length === 1 ? '' : 's'}` +
      `${directory && !dryRun ? ` → ${directory}` : ''}${RESET}\n\n` +
      `${DIM}  pin it:  BRAID_REGISTRY_SNAPSHOT=${snapshot.id}${RESET}\n`,
  );

  return 0;
}

/**
 * `braid registry access` — who can see and load what, and what a change would do to that.
 *
 * With `--against`, the interesting output is the **losses**: access that goes away. A gain is
 * usually deliberate and already visible in the diff; a loss is how a fragment disappears for the
 * people who needed it, and nothing else in the toolchain would tell you.
 */
async function accessCommand(argv: string[]): Promise<number> {
  const manifests = await localManifests(argv);
  if (!manifests) return 1;

  const principals = await resolvePrincipals(argv);
  const against = flag(argv, '--against');

  let before: FragmentManifest[] | undefined;
  if (against) {
    try {
      before = await loadReference(against);
    } catch (error) {
      process.stderr.write(`braid registry access: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  process.stdout.write(formatAccessMatrix(accessMatrix(manifests, principals, before), Boolean(against)));
  return 0;
}

/**
 * Principals to test against: `--as` flags, else the config's `principals`, else anonymous alone.
 *
 * Anonymous is always included. A registry is public by default, so "what can someone with no
 * credentials reach" is the question most worth answering and the easiest to forget to ask.
 */
async function resolvePrincipals(argv: string[]): Promise<NamedPrincipal[]> {
  const fromFlags = argv
    .map((argument, index) => (argument === '--as' ? argv[index + 1] : undefined))
    .filter((value): value is string => Boolean(value))
    .map(parsePrincipal);

  const named = fromFlags.length > 0 ? fromFlags : await configPrincipals(argv);
  const withoutAnonymous = named.filter((principal) => principal.name !== ANONYMOUS.name);

  return [ANONYMOUS, ...withoutAnonymous];
}

async function configPrincipals(argv: string[]): Promise<NamedPrincipal[]> {
  const explicit = flag(argv, '--config');
  const configPath = explicit ? resolve(process.cwd(), explicit) : await findConfig();
  if (!configPath) return [];

  const config = await loadConfig(configPath);
  return Object.entries(config.principals).map(([name, attributes]) => ({ name, ...attributes }));
}

/**
 * `braid registry impact` — the one analysis that is not decidable from the manifests alone.
 *
 * The static checks answer "do these patterns overlap?". This answers "and does anyone go there?",
 * which turns a warning an operator has to judge into a number they can act on. It needs a gateway
 * to have been recording, so it is opt-in at both ends.
 */
async function impactCommand(argv: string[]): Promise<number> {
  const observationsPath = flag(argv, '--observations');
  const against = flag(argv, '--against');

  if (!observationsPath || !against) {
    process.stderr.write(
      'braid registry impact: --observations <file> and --against <ref> are both required\n' +
        '  observations come from a gateway configured with `observe`; see @braidlabs/registry\n',
    );
    return 1;
  }

  const manifests = await localManifests(argv);
  if (!manifests) return 1;

  try {
    const observations = parseObservations(await readFile(resolve(process.cwd(), observationsPath), 'utf8'));
    const published = await loadReference(against);
    process.stdout.write(formatRoutingImpact(await routingImpact(observations, published, manifests)));
    return 0;
  } catch (error) {
    process.stderr.write(`braid registry impact: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------

async function localManifests(argv: string[]): Promise<FragmentManifest[] | null> {
  const source = flag(argv, '--source');
  if (source !== undefined) {
    if (flag(argv, '--config') !== undefined) {
      process.stderr.write('braid registry: pass either --source or --config, not both.\n');
      return null;
    }
    try {
      return await sourceManifests(source);
    } catch (error) {
      process.stderr.write(`braid registry: ${error instanceof Error ? error.message : String(error)}\n`);
      return null;
    }
  }

  const explicit = flag(argv, '--config');
  const configPath = explicit ? resolve(process.cwd(), explicit) : await findConfig();

  if (!configPath) {
    process.stderr.write('braid registry: no braid.config.{json,mjs} found. Run `braid init` to create one.\n');
    return null;
  }

  const config = await loadConfig(configPath);
  // `dev` is local scaffolding, not registry configuration — it must not reach a snapshot, or
  // two developers would publish different ids for the same registry.
  return config.fragments.map(({ dev: _dev, ...manifest }) => manifest);
}

/**
 * Reads a registry from a module: its default export is the manifest array, or a function that
 * returns one (sync or async) — the same shapes a gateway's `registry` option accepts, minus the
 * URL, which `--against` already covers.
 *
 * This is how a composed registry is checked in CI: `supergraph([...])` is a function, and running
 * it is the composition, so a duplicate id or a subgraph outside its routes fails the command.
 */
async function sourceManifests(source: string): Promise<FragmentManifest[]> {
  const path = resolve(process.cwd(), source);
  const module = (await import(pathToFileURL(path).href)) as { default?: unknown };
  const exported = module.default;
  const manifests = typeof exported === 'function' ? await (exported as () => unknown)() : exported;

  if (!Array.isArray(manifests)) {
    throw new Error(
      `${source}: the default export must be an array of manifests or a function returning one, ` +
        `got ${manifests === null ? 'null' : typeof manifests}`,
    );
  }
  return manifests as FragmentManifest[];
}

/**
 * Resolves `--against` to a set of manifests.
 *
 * Accepts a snapshot file, a directory holding one (following its HEAD), or a URL — which may be
 * either a published snapshot or a gateway's own `/__braid/registry` listing, so a running gateway
 * can be diffed without access to its store.
 */
async function loadReference(reference: string): Promise<FragmentManifest[]> {
  if (/^https?:/i.test(reference)) {
    const response = await fetch(reference);
    if (!response.ok) throw new Error(`fetching ${reference} failed with HTTP ${response.status}`);
    const body = (await response.json()) as unknown;
    return manifestsFromUnknown(body, reference);
  }

  const path = resolve(process.cwd(), reference);
  const asDirectory = await readDirectorySnapshot(path);
  if (asDirectory) return [...asDirectory];

  return [...parseSnapshot(await readFile(path, 'utf8')).manifests];
}

async function readDirectorySnapshot(path: string): Promise<readonly FragmentManifest[] | null> {
  const store = fileSnapshotStore({ directory: path });
  const head = await store.head?.();
  if (!head) return null;

  const snapshot = await store.get(head);
  if (!snapshot) throw new Error(`${path} names snapshot ${head} in HEAD, but that snapshot is not there`);
  return snapshot.manifests;
}

function manifestsFromUnknown(body: unknown, source: string): FragmentManifest[] {
  if (Array.isArray(body)) return body as FragmentManifest[];

  const record = body as { manifests?: FragmentManifest[]; items?: FragmentManifest[] };
  if (Array.isArray(record?.manifests)) return record.manifests;
  // a discovery listing: entries are redacted manifests, enough to diff description and routing
  if (Array.isArray(record?.items)) return record.items;

  throw new Error(`${source} is neither a snapshot nor a registry listing`);
}

function parseLabels(argv: string[]): Record<string, string> {
  const labels: Record<string, string> = {};

  argv.forEach((argument, index) => {
    if (argument !== '--label') return;
    const pair = argv[index + 1];
    const equals = pair?.indexOf('=') ?? -1;
    if (pair && equals > 0) labels[pair.slice(0, equals)] = pair.slice(equals + 1);
  });

  return labels;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatFindings(findings: readonly RegistryFinding[], fragmentCount: number): string {
  if (findings.length === 0) {
    return `${GREEN}✓${RESET} ${fragmentCount} fragment${fragmentCount === 1 ? '' : 's'}, no conflicts\n`;
  }

  const lines = findings.map((finding) => {
    const marker = finding.severity === 'error' ? `${RED}error${RESET}` : `${YELLOW}warn ${RESET}`;
    const hint = finding.hint ? `\n        ${DIM}${finding.hint}${RESET}` : '';
    return `  ${marker}  ${finding.message}${hint}`;
  });

  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const warnings = findings.length - errors;

  return `${lines.join('\n')}\n\n${DIM}  ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${
    warnings === 1 ? '' : 's'
  } across ${fragmentCount} fragment${fragmentCount === 1 ? '' : 's'}${RESET}\n`;
}

/**
 * Descriptor notes, ordered so the ones that need a decision come first.
 *
 * A disagreement means the app moved and the manifest did not — the drift this mechanism exists to
 * catch — so it must not scroll past under a wall of routine "applied" lines.
 */
export function formatDescriptorNotes(notes: readonly DescriptorNote[]): string {
  if (notes.length === 0) return '';

  const rank: Record<DescriptorNote['kind'], number> = {
    disagreement: 0,
    'rejected-field': 1,
    invalid: 2,
    unreachable: 3,
    applied: 4,
  };
  const marker: Record<DescriptorNote['kind'], string> = {
    disagreement: `${YELLOW}differs${RESET}`,
    'rejected-field': `${RED}refused${RESET}`,
    invalid: `${RED}invalid${RESET}`,
    unreachable: `${DIM}absent ${RESET}`,
    applied: `${GREEN}applied${RESET}`,
  };

  const lines = [...notes]
    .sort((a, b) => rank[a.kind] - rank[b.kind])
    .map((note) => `  ${marker[note.kind]}  ${note.message}`);

  return `${lines.join('\n')}\n\n`;
}

/**
 * The matrix, with losses first.
 *
 * Losses lead because they are the finding; the grid below is the context that explains them. A
 * grid alone would make an operator scan for the one cell that moved.
 */
export function formatAccessMatrix(matrix: AccessMatrix, isDelta: boolean): string {
  const sections: string[] = [];

  if (isDelta) {
    if (matrix.losses.length > 0) {
      sections.push(
        `${RED}Access removed${RESET}\n` +
          matrix.losses
            .map(
              (loss) =>
                `  ${BOLD}${loss.principal}${RESET} can no longer ${loss.action} ${BOLD}${loss.fragmentId}${RESET}` +
                `${loss.to === 'absent' ? ` ${DIM}(fragment removed)${RESET}` : ''}`,
            )
            .join('\n'),
      );
    }
    if (matrix.gains.length > 0) {
      sections.push(
        `${GREEN}Access granted${RESET}\n` +
          matrix.gains
            .map((gain) => `  ${BOLD}${gain.principal}${RESET} can now ${gain.action} ${BOLD}${gain.fragmentId}${RESET}`)
            .join('\n'),
      );
    }
    if (matrix.unchanged) sections.push(`${GREEN}✓${RESET} no access changes`);
  }

  const width = Math.max(12, ...matrix.rows.map((row) => row.fragmentId.length + 8));
  const columns = matrix.principals.map((name) => Math.max(name.length, 5));

  const header =
    `${DIM}${''.padEnd(width)}${matrix.principals.map((name, index) => name.padEnd(columns[index]! + 2)).join('')}${RESET}`;

  const body = matrix.rows.map((row) => {
    const label = `${row.fragmentId} ${DIM}${row.action}${RESET}`.padEnd(width + DIM.length + RESET.length);
    const cells = row.cells
      .map((cell, index) => {
        const text = cell.changed && isDelta ? `${mark(cell.before)}→${mark(cell.after)}` : mark(cell.after);
        return text.padEnd(columns[index]! + 2 + (text.length - visibleLength(text)));
      })
      .join('');
    return `${label}${cells}`;
  });

  return `${sections.length > 0 ? sections.join('\n\n') + '\n\n' : ''}${header}\n${body.join('\n')}\n`;
}

function mark(outcome: string): string {
  if (outcome === 'allowed') return `${GREEN}✓${RESET}`;
  if (outcome === 'denied') return `${DIM}✗${RESET}`;
  return `${DIM}·${RESET}`;
}

/** Length ignoring ANSI, so padding lines up in a terminal. */
function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex -- measuring around escape sequences is the point
  return text.replace(/\u001b\[[0-9;]*m/g, '').length;
}

/**
 * Impact, per fragment first.
 *
 * The per-path list is evidence; the rollup is the decision. "billing stops composing on 43 paths
 * carrying 1,204 requests" is actionable in a way that forty lines of paths is not.
 */
export function formatRoutingImpact(impact: RoutingImpact): string {
  const scope =
    `${DIM}  measured over ${impact.observed.requests} document request` +
    `${impact.observed.requests === 1 ? '' : 's'} across ${impact.observed.paths} path` +
    `${impact.observed.paths === 1 ? '' : 's'} since ${impact.observed.since}` +
    `${impact.sampled ? ` — ${YELLOW}sampled${RESET}${DIM}, ${impact.observed.evicted} path(s) evicted` : ''}` +
    `${RESET}\n`;

  if (impact.unchanged) {
    return `${GREEN}✓${RESET} no observed traffic changes what it composes\n${scope}`;
  }

  const rollup = impact.byFragment
    .map((fragment) => {
      const lost =
        fragment.lostPaths > 0
          ? `${RED}−${fragment.lostRequests} request${fragment.lostRequests === 1 ? '' : 's'}${RESET} ` +
            `${DIM}on ${fragment.lostPaths} path${fragment.lostPaths === 1 ? '' : 's'}${RESET}`
          : '';
      const gained =
        fragment.gainedPaths > 0
          ? `${GREEN}+${fragment.gainedRequests} request${fragment.gainedRequests === 1 ? '' : 's'}${RESET} ` +
            `${DIM}on ${fragment.gainedPaths} path${fragment.gainedPaths === 1 ? '' : 's'}${RESET}`
          : '';
      return `  ${BOLD}${fragment.fragmentId}${RESET}  ${[lost, gained].filter(Boolean).join('  ')}`;
    })
    .join('\n');

  const sample = impact.paths.slice(0, 10);
  const paths = sample
    .map((path) => {
      const changes = [
        ...path.lost.map((id) => `${RED}−${id}${RESET}`),
        ...path.gained.map((id) => `${GREEN}+${id}${RESET}`),
      ].join(' ');
      return `  ${String(path.count).padStart(6)}  ${path.pathname}  ${changes}`;
    })
    .join('\n');

  const more =
    impact.paths.length > sample.length
      ? `${DIM}  … and ${impact.paths.length - sample.length} more path(s)${RESET}\n`
      : '';

  return (
    `${rollup}\n\n${DIM}${'requests'.padStart(8)}  path${RESET}\n${paths}\n${more}\n` +
    `${DIM}  ${impact.affectedRequests} of ${impact.observed.requests} observed requests affected${RESET}\n${scope}`
  );
}

export function formatDiff(diff: RegistryDiff, against: string): string {
  if (diff.identical) return `${GREEN}✓${RESET} identical to ${against}\n`;

  const lines: string[] = [];

  for (const manifest of diff.added) lines.push(`  ${GREEN}+${RESET} ${BOLD}${manifest.id}${RESET} ${DIM}added${RESET}`);
  for (const manifest of diff.removed) lines.push(`  ${RED}-${RESET} ${BOLD}${manifest.id}${RESET} ${DIM}removed${RESET}`);

  for (const { id, changes } of diff.changed) {
    lines.push(`  ${CYAN}~${RESET} ${BOLD}${id}${RESET}`);
    for (const change of changes) lines.push(formatFieldChange(change));
  }

  const routing = diff.changed.flatMap(({ changes }) => changes).filter((change) => change.owner === 'gateway').length;

  return (
    `${lines.join('\n')}\n\n` +
    `${DIM}  ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed` +
    `${routing > 0 ? ` — ${routing} gateway-owned field${routing === 1 ? '' : 's'} (routing or exposure)` : ''}` +
    `${RESET}\n`
  );
}

function formatFieldChange(change: FieldChange): string {
  const owner = change.owner === 'gateway' ? `${YELLOW}gateway${RESET}` : `${DIM}app${RESET}`;
  return (
    `      ${change.field} ${DIM}(${owner}${DIM})${RESET}\n` +
    `        ${RED}${short(change.before)}${RESET} → ${GREEN}${short(change.after)}${RESET}`
  );
}

function short(value: unknown): string {
  if (value === undefined) return '(unset)';
  if (typeof value === 'function') return '(function)';
  const json = JSON.stringify(value);
  return json.length > 60 ? `${json.slice(0, 57)}…` : json;
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}
