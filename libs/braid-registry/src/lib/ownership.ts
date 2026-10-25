import type { FragmentManifest } from '@braidlabs/gateway';
import type { ShellManifest } from './shell.js';
import { findPierceOverlaps } from './analysis.js';
import { routesMayOverlap } from './route-scope.js';

/**
 * Per-tag ownership: which fragments and shells a caller may change, by the tags they carry.
 *
 * A registry is shared by many teams, and "may publish" is the wrong granularity for it — the
 * payments team should be able to ship its own fragments without being able to change the
 * storefront's. Tags already name who an item belongs to (`finance`, `react`, `growth`), so
 * ownership is expressed in them.
 *
 * The rule, for every item a change adds, alters or removes:
 *
 * - the caller must own **one of its old tags** (if it existed), and
 * - **one of its new tags** (if it still exists).
 *
 * Both, because either alone leaves a hole: checking only old tags lets a team retag its fragment
 * into someone else's area; checking only new tags lets a team claim someone else's fragment by
 * tagging it as its own. An untagged item belongs to no team, so only `*` may change it.
 */

/** The tags a caller owns, or `*` for all of them. */
export type OwnedTags = readonly string[] | '*';

export interface OwnershipViolation {
  /**
   * `route` is a fragment the caller may change, made to pierce pages that a fragment they do not
   * own already pierces — owning an item is not owning every URL it can claim. `shell-route` is the
   * same for a shell: a route that would answer pages another team's shell answers.
   */
  kind: 'fragment' | 'shell' | 'route' | 'shell-route';
  id: string;
  /** The tags that decide who may change it — what it carried before, or carries now if new. */
  tags: string[];
}

export interface RegistryContent {
  manifests: readonly FragmentManifest[];
  shells: readonly ShellManifest[];
}

/** Every item `after` changes relative to `before` that `owned` does not cover. */
export function ownershipViolations(before: RegistryContent, after: RegistryContent, owned: OwnedTags): OwnershipViolation[] {
  if (owned === '*') return [];
  return [
    ...violations('fragment', before.manifests, after.manifests, owned),
    ...violations('shell', before.shells, after.shells, owned),
    ...routeViolations(before.manifests, after.manifests, owned),
    ...shellRouteViolations(before.shells, after.shells, owned),
  ];
}

/**
 * Shell routes that would answer pages a shell the caller does not own answers.
 *
 * A served shell answers a page ahead of the app behind the gateway, and where two shells' routes
 * overlap the one with the earlier id wins. Without this, a team could publish a shell of its own
 * whose route lands on another team's pages — and win them by choosing an id that sorts first.
 *
 * Judged per pair of routes with {@link routesMayOverlap}, which presumes an overlap it cannot rule
 * out, rather than by sampling, which a crafted pattern slips past. A pair that already overlapped
 * in HEAD is not the caller's doing and does not lock them out — but it is the pair of *routes*
 * that is grandfathered, not the pair of shells, so widening a route that overlapped a little into
 * one that overlaps a lot is a new claim.
 */
function shellRouteViolations(
  before: readonly ShellManifest[],
  after: readonly ShellManifest[],
  owned: readonly string[],
): OwnershipViolation[] {
  const routesOf = (shells: readonly ShellManifest[]) =>
    shells.flatMap((shell) =>
      (Array.isArray(shell?.routes) ? shell.routes : [])
        .filter((route) => typeof route?.path === 'string')
        .map((route) => ({ shell, path: route.path })),
    );
  const pairKey = (a: { shell: ShellManifest; path: string }, b: { shell: ShellManifest; path: string }) =>
    [`${a.shell.id}\u0000${a.path}`, `${b.shell.id}\u0000${b.path}`].sort().join('\u0001');

  const overlappingPairs = (shells: readonly ShellManifest[]) => {
    const routes = routesOf(shells);
    const pairs: [(typeof routes)[number], (typeof routes)[number]][] = [];
    for (let i = 0; i < routes.length; i++) {
      for (let j = i + 1; j < routes.length; j++) {
        if (routes[i]!.shell.id !== routes[j]!.shell.id && routesMayOverlap(routes[i]!.path, routes[j]!.path)) {
          pairs.push([routes[i]!, routes[j]!]);
        }
      }
    }
    return pairs;
  };

  const existing = new Set(overlappingPairs(before).map(([a, b]) => pairKey(a, b)));
  const ownsOneOf = (tags: unknown) => tagsOf(tags).some((tag) => owned.includes(tag));

  const found = new Map<string, OwnershipViolation>();
  for (const [a, b] of overlappingPairs(after)) {
    if (existing.has(pairKey(a, b))) continue;
    for (const [mine, theirs] of [[a.shell, b.shell], [b.shell, a.shell]] as const) {
      if (ownsOneOf(mine.tags) && !ownsOneOf(theirs.tags)) {
        found.set(mine.id, { kind: 'shell-route', id: mine.id, tags: tagsOf(theirs.tags) });
      }
    }
  }
  return [...found.values()];
}

/**
 * New pierce overlaps between a fragment the caller owns and one they do not.
 *
 * Only overlaps the change *creates* count: a pair that already overlapped in HEAD is not the
 * caller's doing, and refusing every later edit to their fragment for it would lock them out.
 */
function routeViolations(
  before: readonly FragmentManifest[],
  after: readonly FragmentManifest[],
  owned: readonly string[],
): OwnershipViolation[] {
  const pairKey = (ids: readonly string[]) => [...ids].sort().join('\u0000');
  const existing = new Set(findPierceOverlaps(before).map((finding) => pairKey(finding.fragmentIds)));
  const byId = new Map(after.map((manifest) => [manifest.id, manifest]));
  const ownsOneOf = (tags: unknown) => tagsOf(tags).some((tag) => owned.includes(tag));

  const found = new Map<string, OwnershipViolation>();
  for (const finding of findPierceOverlaps(after)) {
    if (existing.has(pairKey(finding.fragmentIds))) continue;
    const [a, b] = finding.fragmentIds.map((id) => byId.get(id));
    if (!a || !b) continue;
    for (const [mine, theirs] of [[a, b], [b, a]] as const) {
      if (ownsOneOf(mine.tags) && !ownsOneOf(theirs.tags)) {
        found.set(mine.id, { kind: 'route', id: mine.id, tags: tagsOf(theirs.tags) });
      }
    }
  }
  return [...found.values()];
}

/** Tags as a list of strings, whatever arrived: a manifest is client JSON until validated. */
function tagsOf(tags: unknown): string[] {
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
}

function violations(
  kind: OwnershipViolation['kind'],
  before: readonly { id: string; tags?: string[] }[],
  after: readonly { id: string; tags?: string[] }[],
  owned: readonly string[],
): OwnershipViolation[] {
  const was = new Map(before.map((item) => [item.id, item]));
  const now = new Map(after.map((item) => [item.id, item]));
  const ownsOneOf = (tags: unknown) => tagsOf(tags).some((tag) => owned.includes(tag));

  const found: OwnershipViolation[] = [];
  // A duplicated id is two items behind one name, and the gateway serves the first while this
  // comparison would see the last. Nobody short of '*' may publish or pin one.
  for (const list of [before, after]) {
    const seen = new Set<string>();
    for (const item of list) {
      if (seen.has(item.id)) found.push({ kind, id: item.id, tags: tagsOf(item.tags) });
      seen.add(item.id);
    }
  }

  for (const id of new Set([...was.keys(), ...now.keys()])) {
    const old = was.get(id);
    const next = now.get(id);
    if (old && next && canonical(old) === canonical(next)) continue;

    const allowed = (!old || ownsOneOf(old.tags)) && (!next || ownsOneOf(next.tags));
    if (!allowed) found.push({ kind, id, tags: tagsOf((old ?? next)?.tags) });
  }
  return found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** JSON with keys sorted, so an item re-sent with its keys in another order is not "changed". */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/** The refusal message for a set of violations — names every item, so the fix is obvious. */
export function describeViolations(found: readonly OwnershipViolation[]): string {
  const names = found.map((item) =>
    item.kind === 'route'
      ? `fragment "${item.id}", whose pierce patterns would claim pages a fragment tagged ${item.tags.join(', ') || '(untagged)'} already pierces`
      : item.kind === 'shell-route'
        ? `shell "${item.id}", whose routes would answer pages a shell tagged ${item.tags.join(', ') || '(untagged)'} already answers`
        : `${item.kind} "${item.id}" (${item.tags.length ? `tags: ${item.tags.join(', ')}` : 'untagged'})`,
  );
  return `you may not change ${names.join('; ')} — only items carrying a tag you own`;
}
