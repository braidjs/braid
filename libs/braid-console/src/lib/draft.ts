import type { FragmentManifest } from '@braidlabs/gateway';
import { diffRegistries, validateRegistry, type RegistryDiff, type RegistryFinding } from '@braidlabs/registry';

/**
 * A draft registry, held in the browser.
 *
 * Drafts are deliberately **not** server state. Only published snapshots are, which keeps the
 * write API to three routes and sidesteps multi-editor reconciliation entirely. The cost is that
 * a draft does not follow you between devices — the right trade until someone actually needs that.
 *
 * Pure functions over plain data, so the interesting behavior is testable without rendering
 * anything.
 */
export interface Draft {
  /** The manifests being edited. */
  manifests: FragmentManifest[];
  /** What was pinned when this draft started, for diffing and for discarding. */
  base: FragmentManifest[];
  /** Snapshot id the draft was branched from, if any. */
  baseId: string | null;
}

export function createDraft(base: readonly FragmentManifest[], baseId: string | null = null): Draft {
  return { manifests: clone(base), base: clone(base), baseId };
}

export interface DraftStatus {
  findings: RegistryFinding[];
  diff: RegistryDiff;
  /** True when the draft has errors and cannot be published. */
  blocked: boolean;
  /** True when nothing has been changed. */
  clean: boolean;
}

/**
 * Everything the UI needs to decide what to show and whether to allow publishing.
 *
 * Runs the same `validateRegistry` the server runs. Doing it here is a convenience for whoever is
 * typing, not a substitute: the server validates again, because a client check is advice and the
 * server's is the decision.
 */
export function draftStatus(draft: Draft): DraftStatus {
  const findings = validateRegistry(draft.manifests);
  const diff = diffRegistries(draft.base, draft.manifests);

  return {
    findings,
    diff,
    blocked: findings.some((finding) => finding.severity === 'error'),
    clean: diff.identical,
  };
}

export function updateFragment(draft: Draft, index: number, patch: Partial<FragmentManifest>): Draft {
  const manifests = draft.manifests.map((manifest, position) =>
    position === index ? prune({ ...manifest, ...patch }) : manifest,
  );
  return { ...draft, manifests };
}

export function addFragment(draft: Draft, tags?: string[]): Draft {
  return {
    ...draft,
    manifests: [...draft.manifests, { id: uniqueId(draft.manifests), endpoint: '', ...(tags ? { tags } : {}) }],
  };
}

export function removeFragment(draft: Draft, index: number): Draft {
  return { ...draft, manifests: draft.manifests.filter((_, position) => position !== index) };
}

/** Discards every edit, returning to the snapshot the draft branched from. */
export function resetDraft(draft: Draft): Draft {
  return createDraft(draft.base, draft.baseId);
}

/**
 * Drops fields the editor cleared.
 *
 * An empty string is how a text input says "unset", and the difference matters: a manifest
 * carrying `title: ''` is not the same as one that omits `title`, because an omitted field is what
 * lets a fragment descriptor supply it.
 */
function prune(manifest: FragmentManifest): FragmentManifest {
  const result: Record<string, unknown> = { ...manifest };

  for (const [field, value] of Object.entries(result)) {
    const empty =
      value === undefined ||
      value === '' ||
      (Array.isArray(value) && value.length === 0) ||
      (isPlainObject(value) && Object.keys(value).length === 0);
    // id and endpoint stay even when blank, so validation can report them as the errors they are
    if (empty && field !== 'id' && field !== 'endpoint') delete result[field];
  }

  return result as unknown as FragmentManifest;
}

/** Parses a comma-separated input into a list, dropping blanks. */
export function parseList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function formatList(value: readonly string[] | undefined): string {
  return (value ?? []).join(', ');
}

function uniqueId(manifests: readonly FragmentManifest[]): string {
  const taken = new Set(manifests.map((manifest) => manifest.id));
  let candidate = 'new-fragment';
  let suffix = 2;
  while (taken.has(candidate)) candidate = `new-fragment-${suffix++}`;
  return candidate;
}

function clone(manifests: readonly FragmentManifest[]): FragmentManifest[] {
  // structuredClone would choke on a `fetch`-function endpoint, which a manifest may legitimately
  // carry; those cannot be edited in a UI anyway, so they pass through by reference.
  return manifests.map((manifest) => ({ ...manifest }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
