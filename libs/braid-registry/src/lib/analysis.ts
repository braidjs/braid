import type { FragmentManifest } from '@braidlabs/gateway';
import { validateShells, type ShellManifest } from './shell.js';

/**
 * Registry analysis: what is wrong with a set of manifests, and what a proposed set would change.
 *
 * Framework-free and dependency-free on purpose. The same functions back `braid registry validate`
 * in a terminal and the console in a browser; neither owns the analysis, and a team that wants a
 * third surface should not have to reimplement it.
 */

export type FindingSeverity = 'error' | 'warning';

export interface RegistryFinding {
  severity: FindingSeverity;
  /** Stable machine-readable code, for filtering and for tests. */
  code: FindingCode;
  message: string;
  /** Fragments involved. Two ids for a conflict, one for everything else. */
  fragmentIds: string[];
  /** Shells involved, for findings about a shell. Absent on fragment-only findings. */
  shellIds?: string[];
  hint?: string;
}

export type FindingCode =
  | 'duplicate-id'
  | 'invalid-id'
  | 'missing-endpoint'
  | 'invalid-endpoint'
  | 'endpoint-not-allowed'
  | 'invalid-pierce-pattern'
  | 'urlpattern-unavailable'
  | 'pierce-overlap'
  | 'custom-element-incomplete'
  | 'empty-access-rule'
  | 'invalid-shell-id'
  | 'duplicate-shell-id'
  | 'invalid-shell-framework'
  | 'invalid-shell-layout'
  | 'invalid-route-path'
  | 'slot-unknown-area'
  | 'slot-unknown-fragment'
  | 'unsafe-shell-url'
  | 'invalid-shell-field'
  | 'shell-route-conflict'
  | 'shell-route-overlap';

/**
 * Validates a registry without contacting anything.
 *
 * Everything here is decidable from the manifests alone, which is what makes it cheap enough to
 * run at save time and in CI rather than only in a preview pane.
 */
export function validateRegistry(
  manifests: readonly FragmentManifest[],
  options: {
    shells?: readonly ShellManifest[];
    /**
     * Origins a URL endpoint may be on — `['https://billing.internal', 'https://cdn.example']`.
     * Omit to allow any. The gateway proxies `/__braid/frag/:id/*` to a fragment's endpoint, so an
     * endpoint is a door from the internet into wherever it points; this is the list of rooms.
     */
    endpointOrigins?: readonly string[];
  } = {},
): RegistryFinding[] {
  const allowedOrigins = options.endpointOrigins ? new Set(options.endpointOrigins.map((origin) => new URL(origin).origin)) : null;
  const findings: RegistryFinding[] = [];
  const seen = new Set<string>();

  for (const manifest of manifests) {
    const id = manifest.id;

    if (!id || id.includes('/')) {
      findings.push({
        severity: 'error',
        code: 'invalid-id',
        fragmentIds: [String(id)],
        message: `fragment id "${id}" is invalid`,
        hint: 'ids must be non-empty and must not contain "/" — they address the fragment in /__braid/frag/:id/',
      });
    } else if (seen.has(id)) {
      findings.push({
        severity: 'error',
        code: 'duplicate-id',
        fragmentIds: [id],
        message: `fragment id "${id}" is registered more than once`,
        hint: 'the later registration silently wins; give one of them a different id',
      });
    }
    if (id) seen.add(id);

    findings.push(...validateEndpoint(manifest, allowedOrigins));
    findings.push(...validatePierce(manifest));
    findings.push(...validateAdapter(manifest));
    findings.push(...validateAccess(manifest));
  }

  findings.push(...findPierceOverlaps(manifests));
  if (options.shells) {
    findings.push(...validateShells(options.shells, manifests));
    findings.push(...findShellRouteOverlaps(options.shells));
  }
  return findings;
}

function validateEndpoint(manifest: FragmentManifest, allowedOrigins: ReadonlySet<string> | null = null): RegistryFinding[] {
  if (!manifest.endpoint) {
    return [
      {
        severity: 'error',
        code: 'missing-endpoint',
        fragmentIds: [manifest.id],
        message: `fragment "${manifest.id}" has no endpoint`,
        hint: 'set endpoint to the URL the fragment is served from, or to a fetch-compatible function',
      },
    ];
  }

  if (typeof manifest.endpoint !== 'string') return [];

  let origin: string;
  try {
    origin = new URL(manifest.endpoint).origin;
  } catch {
    return [
      {
        severity: 'error',
        code: 'invalid-endpoint',
        fragmentIds: [manifest.id],
        message: `fragment "${manifest.id}" has an endpoint that is not an absolute URL: "${manifest.endpoint}"`,
        hint: 'endpoints are absolute — a relative path has no origin to resolve against on the server',
      },
    ];
  }
  if (allowedOrigins && !allowedOrigins.has(origin)) {
    return [
      {
        severity: 'error',
        code: 'endpoint-not-allowed',
        fragmentIds: [manifest.id],
        message: `fragment "${manifest.id}" has an endpoint on ${origin}, which is not an allowed endpoint origin`,
        hint: `endpoints may be on: ${[...allowedOrigins].join(', ')}`,
      },
    ];
  }
  return [];
}

function validatePierce(manifest: FragmentManifest): RegistryFinding[] {
  const findings: RegistryFinding[] = [];
  const patterns = manifest.pierce ?? [];

  // Without a global URLPattern every constructor call throws, which would report each pattern as
  // invalid syntax; the runtime is what is wrong, and saying so once is the useful finding.
  if (patterns.length > 0 && typeof URLPattern === 'undefined') {
    return [
      {
        severity: 'error',
        code: 'urlpattern-unavailable',
        fragmentIds: [manifest.id],
        message: `pierce patterns cannot be compiled: this runtime has no global URLPattern`,
        hint: 'use Node 24 or newer (URLPattern is global from Node 23.8), or a runtime that implements the URL Pattern API',
      },
    ];
  }

  for (const pattern of patterns) {
    try {
      new URLPattern({ pathname: pattern });
    } catch {
      findings.push({
        severity: 'error',
        code: 'invalid-pierce-pattern',
        fragmentIds: [manifest.id],
        message: `fragment "${manifest.id}" declares an invalid pierce pattern "${pattern}"`,
        hint: 'patterns use URLPattern pathname syntax, e.g. /checkout/* or /orders/:id',
      });
    }
  }

  return findings;
}

function validateAdapter(manifest: FragmentManifest): RegistryFinding[] {
  if (manifest.adapter !== 'custom-element') return [];
  if (manifest.entry && manifest.element) return [];

  const missing = [!manifest.entry && 'entry', !manifest.element && 'element'].filter(Boolean);
  return [
    {
      severity: 'error',
      code: 'custom-element-incomplete',
      fragmentIds: [manifest.id],
      message: `fragment "${manifest.id}" uses the custom-element adapter but is missing ${missing.join(' and ')}`,
      hint: 'the adapter needs an entry module to evaluate and the tag name that module defines',
    },
  ];
}

function validateAccess(manifest: FragmentManifest): RegistryFinding[] {
  const findings: RegistryFinding[] = [];

  for (const [name, rule] of Object.entries(manifest.access ?? {})) {
    if (!rule) continue;
    const rolesEmpty = Array.isArray(rule.roles) && rule.roles.length === 0;
    const scopesEmpty = Array.isArray(rule.scopes) && rule.scopes.length === 0;
    if (!rolesEmpty && !scopesEmpty) continue;

    findings.push({
      severity: 'warning',
      code: 'empty-access-rule',
      fragmentIds: [manifest.id],
      message: `fragment "${manifest.id}" declares access.${name} with an empty rule`,
      hint: 'an empty roles/scopes array restricts nothing — omit the rule if it is meant to be public, or fill it in',
    });
  }

  return findings;
}

/**
 * Finds fragments whose pierce patterns can match the same page URL.
 *
 * Two fragments *may* legitimately pierce one page — that is how a page composes several
 * fragments — so this is a warning, not an error. It is reported because the overlap is usually
 * accidental, and because the accidental case (a stray `/*`) is invisible in a diff that shows one
 * changed line.
 *
 * **This is a heuristic.** `URLPattern` exposes no intersection operation, so overlap is probed:
 * each pattern is reduced to a concrete sample path by filling wildcards and named groups with a
 * sentinel segment, and every sample is tested against every other pattern. That catches the cases
 * that occur in practice (a prefix wildcard swallowing a sibling route, duplicated patterns) and
 * will miss exotic ones — patterns that intersect only on inputs the sentinel does not generate,
 * such as two disjoint regex groups.
 */
export function findPierceOverlaps(manifests: readonly FragmentManifest[]): RegistryFinding[] {
  const findings: RegistryFinding[] = [];
  const compiled: { id: string; pattern: string; matcher: URLPattern; sample: string }[] = [];

  for (const manifest of manifests) {
    for (const pattern of manifest.pierce ?? []) {
      try {
        compiled.push({
          id: manifest.id,
          pattern,
          matcher: new URLPattern({ pathname: pattern }),
          sample: samplePath(pattern),
        });
      } catch {
        // reported by validatePierce; an uncompilable pattern cannot overlap with anything
      }
    }
  }

  for (let i = 0; i < compiled.length; i++) {
    for (let j = i + 1; j < compiled.length; j++) {
      const a = compiled[i]!;
      const b = compiled[j]!;
      if (a.id === b.id) continue;

      const overlaps = b.matcher.test({ pathname: a.sample }) || a.matcher.test({ pathname: b.sample });
      if (!overlaps) continue;

      findings.push({
        severity: 'warning',
        code: 'pierce-overlap',
        fragmentIds: [a.id, b.id],
        message: `"${a.id}" (${a.pattern}) and "${b.id}" (${b.pattern}) both pierce the same page URLs`,
        hint: 'intentional when a page composes both fragments; a mistake when one pattern is wider than intended',
      });
    }
  }

  return findings;
}

/** Reduces a pattern to one concrete path it matches, for probing. */
/**
 * Routes in different shells that can answer the same page — `/billing/*` and `/billing/:id`.
 * Exact duplicates are an error (`shell-route-conflict`); an overlap is a warning, because the
 * gateway resolves it deterministically (shells in id order) but probably not as anyone intended.
 */
export function findShellRouteOverlaps(shells: readonly ShellManifest[]): RegistryFinding[] {
  const compiled: { shell: string; path: string; matcher: URLPattern; sample: string }[] = [];
  if (typeof URLPattern === 'undefined') return [];
  for (const shell of shells) {
    for (const route of Array.isArray(shell?.routes) ? shell.routes : []) {
      try {
        compiled.push({ shell: shell.id, path: route.path, matcher: new URLPattern({ pathname: route.path }), sample: samplePath(route.path) });
      } catch {
        // reported by validateShells
      }
    }
  }
  const findings: RegistryFinding[] = [];
  for (let i = 0; i < compiled.length; i++) {
    for (let j = i + 1; j < compiled.length; j++) {
      const a = compiled[i]!;
      const b = compiled[j]!;
      if (a.shell === b.shell || a.path === b.path) continue;
      if (!(b.matcher.test({ pathname: a.sample }) || a.matcher.test({ pathname: b.sample }))) continue;
      findings.push({
        severity: 'warning',
        code: 'shell-route-overlap',
        shellIds: [a.shell, b.shell],
        fragmentIds: [],
        message: `shells "${a.shell}" (${a.path}) and "${b.shell}" (${b.path}) can both answer the same page`,
        hint: 'the shell with the earlier id wins; narrow one of the routes so each page has one shell',
      });
    }
  }
  return findings;
}

function samplePath(pattern: string): string {
  return (
    pattern
      // named groups and wildcards both stand for "some segment"
      .replace(/:[A-Za-z0-9_]+/g, '__braid_probe')
      .replace(/\*/g, '__braid_probe')
      .replace(/\{[^}]*\}/g, '') || '/'
  );
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * Which side of the manifest a field belongs to.
 *
 * The split is generated by one question: *can a lie here hurt anyone but the liar?* Fields whose
 * misstatement affects other fragments, other pages, or who can reach what are the gateway's;
 * fields where a wrong value only degrades the fragment itself may be self-reported. This is the
 * same rule that governs whether a fragment descriptor may supply a field.
 */
export type FieldOwner = 'gateway' | 'app';

const GATEWAY_OWNED = new Set(['endpoint', 'pierce', 'access', 'timeoutMs', 'fallback']);

export function fieldOwner(field: string): FieldOwner {
  return GATEWAY_OWNED.has(field) ? 'gateway' : 'app';
}

export interface FieldChange {
  field: string;
  owner: FieldOwner;
  before: unknown;
  after: unknown;
}

export interface RegistryDiff {
  added: FragmentManifest[];
  removed: FragmentManifest[];
  changed: { id: string; changes: FieldChange[] }[];
  /** True when nothing differs — the same registry, however it was produced. */
  identical: boolean;
}

/**
 * Structural diff between two registries.
 *
 * Changes are labelled with the field's owner, which is what makes the output actionable rather
 * than merely accurate: a changed `pierce` is a routing change with page-wide blast radius, while
 * a changed `description` is a label. A flat list of altered keys makes those look alike.
 */
export function diffRegistries(
  before: readonly FragmentManifest[],
  after: readonly FragmentManifest[],
): RegistryDiff {
  const beforeById = new Map(before.map((m) => [m.id, m]));
  const afterById = new Map(after.map((m) => [m.id, m]));

  const added = after.filter((m) => !beforeById.has(m.id));
  const removed = before.filter((m) => !afterById.has(m.id));
  const changed: RegistryDiff['changed'] = [];

  for (const [id, afterManifest] of afterById) {
    const beforeManifest = beforeById.get(id);
    if (!beforeManifest) continue;

    const changes = diffManifest(beforeManifest, afterManifest);
    if (changes.length > 0) changed.push({ id, changes });
  }

  return {
    added,
    removed,
    changed,
    identical: added.length === 0 && removed.length === 0 && changed.length === 0,
  };
}

function diffManifest(before: FragmentManifest, after: FragmentManifest): FieldChange[] {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: FieldChange[] = [];

  for (const field of [...fields].sort()) {
    const a = (before as unknown as Record<string, unknown>)[field];
    const b = (after as unknown as Record<string, unknown>)[field];
    if (sameValue(a, b)) continue;
    changes.push({ field, owner: fieldOwner(field), before: a, after: b });
  }

  return changes;
}

/**
 * Value equality for manifest fields.
 *
 * Functions compare by identity — an `endpoint` given as a fetch function cannot be compared
 * structurally, and reporting two distinct closures as "changed" is the honest answer.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'function' || typeof b === 'function') return false;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
