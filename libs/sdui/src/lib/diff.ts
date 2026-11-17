import { canonicalJson } from '@braidlabs/skew';
import type { SduiCatalog } from './catalog.js';
import { type CodeSteps, migrate } from './migrate.js';
import {
  type Screen,
  type SduiAction,
  type SduiNode,
  isRecord,
  own,
  screenId,
} from './model.js';

/**
 * A semantic diff of two versions of a screen.
 *
 * Two things make it trustworthy where a text diff of the JSON is not:
 *
 * - **Nodes are matched by their stable ids**, so moving a card is one move, not a deletion in one
 *   place and an unrelated addition in another.
 * - **It is contract-aware.** Two versions authored against different catalogs are first migrated
 *   to the catalog's newest shapes, so a component that was merely *upgraded* is not reported as
 *   edited. What the catalog did is listed on its own, apart from what a person did.
 */

export interface NodePlace {
  /** `null` for the root. */
  readonly parentId: string | null;
  readonly slot: string | null;
  readonly index: number;
}

export type ScreenChange =
  | ({
      readonly kind: 'added';
      readonly nodeId: string;
      readonly type: string;
    } & NodePlace)
  | { readonly kind: 'removed'; readonly nodeId: string; readonly type: string }
  | {
      readonly kind: 'moved';
      readonly nodeId: string;
      readonly type: string;
      readonly from: NodePlace;
      readonly to: NodePlace;
    }
  /** Props differ once both sides are at the same contract version. `paths` says where. */
  | {
      readonly kind: 'content';
      readonly nodeId: string;
      readonly type: string;
      readonly paths: readonly string[];
    }
  | {
      readonly kind: 'type';
      readonly nodeId: string;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly kind:
        | 'actions'
        | 'visibility'
        | 'fallback'
        | 'required'
        | 'analytics';
      readonly nodeId: string;
      readonly type: string;
    }
  /** Something about the screen itself: its title, slug, or an authored state. */
  | { readonly kind: 'screen'; readonly paths: readonly string[] };

/** A node whose contract version differs between the two sides — the catalog's doing, not an edit. */
export interface CatalogUpgrade {
  readonly nodeId: string;
  readonly type: string;
  readonly from: number;
  readonly to: number;
  /** Fields the upgrade filled with defaults, which nobody wrote. Worth a look. */
  readonly derivedPaths: readonly string[];
}

export interface ScreenDiff {
  /** The two sides are the same content. Nothing else in the result is populated. */
  readonly unchanged: boolean;
  readonly beforeId: string;
  readonly afterId: string;
  readonly changes: readonly ScreenChange[];
  readonly catalogUpgrades: readonly CatalogUpgrade[];
}

export interface DiffOptions {
  readonly codeSteps?: CodeSteps;
  /** The sides' content addresses, when the caller already has them. */
  readonly beforeId?: string;
  readonly afterId?: string;
}

interface Indexed {
  readonly node: SduiNode;
  readonly place: NodePlace;
}

export function diffScreens(
  before: Screen,
  after: Screen,
  catalog: SduiCatalog,
  options: DiffOptions = {},
): ScreenDiff {
  const beforeId = options.beforeId ?? screenId(before);
  const afterId = options.afterId ?? screenId(after);
  // The same address is the same content: there is nothing to walk.
  if (beforeId === afterId)
    return {
      unchanged: true,
      beforeId,
      afterId,
      changes: [],
      catalogUpgrades: [],
    };

  const migrateOptions = { codeSteps: options.codeSteps };

  /** Props at the catalog's newest version of their contract, so two authoring versions compare. */
  const upgrade = (
    kind: 'components' | 'actions',
    type: string,
    v: number,
    props: unknown,
  ): { value: unknown; derived: readonly string[]; pinned?: number } => {
    const contract = own(catalog[kind], type)?.contract;
    if (contract && v <= contract.current) {
      const result = migrate(
        contract,
        props ?? {},
        v,
        contract.current,
        migrateOptions,
      );
      if (result.ok)
        return { value: result.value, derived: result.derivedPaths };
    }
    // Cannot be brought to a common version, so the version is part of what is compared.
    return { value: props ?? {}, derived: [], pinned: v };
  };

  const comparableAction = (action: SduiAction): unknown => {
    const upgraded = upgrade('actions', action.type, action.v, action.props);
    return {
      type: action.type,
      props: upgraded.value,
      ...(upgraded.pinned !== undefined ? { v: upgraded.pinned } : {}),
      ...(action.unsupported ? { unsupported: action.unsupported } : {}),
      ...(action.fallback
        ? { fallback: comparableAction(action.fallback) }
        : {}),
    };
  };

  /** A whole subtree in comparable form — for fallbacks and authored states, compared as a unit. */
  const comparableTree = (node: SduiNode): unknown => {
    const upgraded = upgrade('components', node.type, node.v, node.props);
    return {
      id: node.id,
      type: node.type,
      props: upgraded.value,
      ...(upgraded.pinned !== undefined ? { v: upgraded.pinned } : {}),
      ...(node.slots
        ? {
            slots: Object.fromEntries(
              Object.entries(node.slots).map(([slot, children]) => [
                slot,
                children.map(comparableTree),
              ]),
            ),
          }
        : {}),
      ...(node.actions
        ? {
            actions: Object.fromEntries(
              Object.entries(node.actions).map(([name, action]) => [
                name,
                comparableAction(action),
              ]),
            ),
          }
        : {}),
      ...(node.visibility ? { visibility: node.visibility } : {}),
      ...(node.fallback ? { fallback: comparableTree(node.fallback) } : {}),
      ...(node.required ? { required: true } : {}),
      ...(node.analytics ? { analytics: node.analytics } : {}),
    };
  };

  const index = (screen: Screen): Map<string, Indexed> => {
    const map = new Map<string, Indexed>();
    const visit = (node: SduiNode, place: NodePlace): void => {
      map.set(node.id, { node, place });
      for (const [slot, children] of Object.entries(node.slots ?? {})) {
        children.forEach((child, position) =>
          visit(child, { parentId: node.id, slot, index: position }),
        );
      }
    };
    visit(screen.root, { parentId: null, slot: null, index: 0 });
    return map;
  };

  const was = index(before);
  const now = index(after);
  const changes: ScreenChange[] = [];
  const catalogUpgrades: CatalogUpgrade[] = [];

  const screenPaths: string[] = [];
  if (before.title !== after.title) screenPaths.push('title');
  if (before.slug !== after.slug) screenPaths.push('slug');
  for (const name of ['loading', 'empty', 'error', 'offline'] as const) {
    const comparable = (
      value: 'auto' | 'system' | SduiNode | undefined,
    ): string =>
      canonicalJson(
        value === undefined || typeof value === 'string'
          ? (value ?? null)
          : comparableTree(value),
      );
    if (comparable(before.states?.[name]) !== comparable(after.states?.[name]))
      screenPaths.push(`states.${name}`);
  }
  if (screenPaths.length > 0)
    changes.push({ kind: 'screen', paths: screenPaths });

  // Children that stayed under the same parent and slot, and changed order: the fewest that
  // explain the new order are the ones that moved, so reordering two cards is one move.
  const reordered = new Set<string>();
  const containers = new Map<string, { before: string[]; after: string[] }>();
  const containerOf = (place: NodePlace): string =>
    `${place.parentId}\u0000${place.slot}`;
  for (const [id, entry] of was) {
    const other = now.get(id);
    if (!other || containerOf(other.place) !== containerOf(entry.place))
      continue;
    const lists = containers.get(containerOf(entry.place)) ?? {
      before: [],
      after: [],
    };
    lists.before[entry.place.index] = id;
    lists.after[other.place.index] = id;
    containers.set(containerOf(entry.place), lists);
  }
  for (const lists of containers.values()) {
    const a = lists.before.filter((id) => id !== undefined);
    const b = lists.after.filter((id) => id !== undefined);
    const kept = new Set(longestCommonSubsequence(a, b));
    for (const id of b) if (!kept.has(id)) reordered.add(id);
  }

  for (const [id, entry] of now) {
    const previous = was.get(id);
    const node = entry.node;
    if (!previous) {
      changes.push({
        kind: 'added',
        nodeId: id,
        type: node.type,
        ...entry.place,
      });
      continue;
    }
    const old = previous.node;
    if (
      containerOf(previous.place) !== containerOf(entry.place) ||
      reordered.has(id)
    ) {
      changes.push({
        kind: 'moved',
        nodeId: id,
        type: node.type,
        from: previous.place,
        to: entry.place,
      });
    }
    if (old.type !== node.type) {
      changes.push({ kind: 'type', nodeId: id, from: old.type, to: node.type });
      continue;
    }

    const left = upgrade('components', old.type, old.v, old.props);
    const right = upgrade('components', node.type, node.v, node.props);
    if (old.v !== node.v) {
      const contract = own(catalog.components, node.type)?.contract;
      const step =
        contract && old.v < node.v && node.v <= contract.current
          ? migrate(contract, old.props ?? {}, old.v, node.v, migrateOptions)
          : null;
      catalogUpgrades.push({
        nodeId: id,
        type: node.type,
        from: old.v,
        to: node.v,
        derivedPaths: step?.ok ? step.derivedPaths : [],
      });
    }
    const paths = changedPaths(left.value, right.value);
    if (paths.length > 0 || left.pinned !== right.pinned)
      changes.push({ kind: 'content', nodeId: id, type: node.type, paths });

    const differs = (a: unknown, b: unknown): boolean =>
      canonicalJson(a ?? null) !== canonicalJson(b ?? null);
    const actionsOf = (n: SduiNode): unknown =>
      Object.fromEntries(
        Object.entries(n.actions ?? {}).map(([name, action]) => [
          name,
          comparableAction(action),
        ]),
      );
    if (differs(actionsOf(old), actionsOf(node)))
      changes.push({ kind: 'actions', nodeId: id, type: node.type });
    if (differs(old.visibility, node.visibility))
      changes.push({ kind: 'visibility', nodeId: id, type: node.type });
    if (
      differs(
        old.fallback && comparableTree(old.fallback),
        node.fallback && comparableTree(node.fallback),
      )
    )
      changes.push({ kind: 'fallback', nodeId: id, type: node.type });
    if ((old.required ?? false) !== (node.required ?? false))
      changes.push({ kind: 'required', nodeId: id, type: node.type });
    if (differs(old.analytics, node.analytics))
      changes.push({ kind: 'analytics', nodeId: id, type: node.type });
  }

  for (const [id, entry] of was) {
    if (!now.has(id))
      changes.push({ kind: 'removed', nodeId: id, type: entry.node.type });
  }

  return { unchanged: false, beforeId, afterId, changes, catalogUpgrades };
}

/** Dot-paths at which two values differ. Arrays of different lengths differ as a whole. */
export function changedPaths(a: unknown, b: unknown, prefix = ''): string[] {
  if (isRecord(a) && isRecord(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((key) =>
      changedPaths(a[key], b[key], prefix ? `${prefix}.${key}` : key),
    );
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((element, position) =>
      changedPaths(element, b[position], `${prefix}[${position}]`),
    );
  }
  return canonicalJson(a ?? null) === canonicalJson(b ?? null) ? [] : [prefix];
}

/** Beyond this many table cells an exact answer is not worth its memory. */
const LCS_CELL_LIMIT = 4_000_000;

function longestCommonSubsequence(
  a: readonly string[],
  b: readonly string[],
): string[] {
  if (a.length * b.length > LCS_CELL_LIMIT) {
    // A list this long is data, not a layout. Take a run that is in order in both — not always
    // the longest, so a few extra nodes may be reported as moved, but never a missed move.
    const position = new Map(a.map((id, index) => [id, index]));
    const out: string[] = [];
    let last = -1;
    for (const id of b) {
      const at = position.get(id);
      if (at !== undefined && at > last) {
        out.push(id);
        last = at;
      }
    }
    return out;
  }
  const rows = a.length + 1;
  const columns = b.length + 1;
  const table = new Uint32Array(rows * columns);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * columns + j] =
        a[i] === b[j]
          ? (table[(i + 1) * columns + j + 1] as number) + 1
          : Math.max(
              table[(i + 1) * columns + j] as number,
              table[i * columns + j + 1] as number,
            );
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(a[i] as string);
      i++;
      j++;
    } else if (
      (table[(i + 1) * columns + j] as number) >=
      (table[i * columns + j + 1] as number)
    ) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}
