import {
  type MigrationContext,
  canonicalJson,
  defaultMigrationContext,
} from '@braidlabs/skew';
import type { SduiCatalog } from './catalog.js';
import { own } from './internal.js';
import { type CodeSteps, migrate } from './migrate.js';
import {
  type Screen,
  type SduiAction,
  type SduiNode,
  screenId,
} from './model.js';
import { changedPaths } from './paths.js';

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
  /** Something about the screen itself: its id, title, slug, or an authored state. */
  | { readonly kind: 'screen'; readonly paths: readonly string[] };

/** Something whose contract version differs between the two sides — the catalog's doing, not an edit. */
export interface CatalogUpgrade {
  /** The node concerned. For an action, the node the action is on. */
  readonly nodeId: string;
  readonly type: string;
  readonly from: number;
  readonly to: number;
  /** Fields the upgrade filled with defaults, which nobody wrote. Worth a look. */
  readonly derivedPaths: readonly string[];
  /** Set when it is an action that was upgraded: its name on the node. */
  readonly action?: string;
}

export interface ScreenDiff {
  /** Nothing differs: neither content nor contract versions. Nothing else is populated. */
  readonly unchanged: boolean;
  readonly beforeId: string;
  readonly afterId: string;
  readonly changes: readonly ScreenChange[];
  readonly catalogUpgrades: readonly CatalogUpgrade[];
}

export interface DiffOptions {
  readonly codeSteps?: CodeSteps;
  /** The clock `$now` reads. One instant is taken from it and used for both sides. */
  readonly context?: MigrationContext;
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

  // Both sides are brought to the newest version at one instant. Read the clock separately for
  // each and a `$now` field differs between two copies of the same untouched node.
  const instant = (options.context ?? defaultMigrationContext).now();
  const migrateOptions = {
    codeSteps: options.codeSteps,
    context: { ...(options.context ?? {}), now: () => instant },
  };

  const changes: ScreenChange[] = [];
  const catalogUpgrades: CatalogUpgrade[] = [];

  /** Props at the catalog's newest version of their contract, so two authoring versions compare. */
  const upgrade = (
    kind: 'components' | 'actions',
    type: string,
    v: number,
    props: unknown,
  ): { value: unknown; pinned?: number } => {
    const contract = own(catalog[kind], type)?.contract;
    if (contract && v <= contract.current) {
      const result = migrate(
        contract,
        props ?? {},
        v,
        contract.current,
        migrateOptions,
      );
      if (result.ok) return { value: result.value };
    }
    // Cannot be brought to a common version, so the version is part of what is compared.
    return { value: props ?? {}, pinned: v };
  };

  const noteUpgrade = (
    kind: 'components' | 'actions',
    nodeId: string,
    type: string,
    from: number,
    to: number,
    props: unknown,
    action?: string,
  ): void => {
    if (from === to) return;
    const contract = own(catalog[kind], type)?.contract;
    const step =
      contract && from < to && to <= contract.current
        ? migrate(contract, props ?? {}, from, to, migrateOptions)
        : null;
    catalogUpgrades.push({
      nodeId,
      type,
      from,
      to,
      derivedPaths: step?.ok ? step.derivedPaths : [],
      ...(action !== undefined ? { action } : {}),
    });
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
            slots: Object.entries(node.slots).map(([slot, children]) => [
              slot,
              children.map(comparableTree),
            ]),
          }
        : {}),
      ...(node.actions
        ? {
            actions: Object.entries(node.actions).map(([name, action]) => [
              name,
              comparableAction(action),
            ]),
          }
        : {}),
      ...(node.visibility ? { visibility: node.visibility } : {}),
      ...(node.fallback ? { fallback: comparableTree(node.fallback) } : {}),
      ...(node.required ? { required: true } : {}),
      ...(node.analytics ? { analytics: node.analytics } : {}),
    };
  };

  /** Every node in a subtree, by id — so an upgrade inside a fallback or a state is still noticed. */
  const flatten = (
    root: SduiNode | undefined,
    into = new Map<string, SduiNode>(),
  ): Map<string, SduiNode> => {
    if (!root) return into;
    into.set(root.id, root);
    for (const children of Object.values(root.slots ?? {}))
      for (const child of children) flatten(child, into);
    flatten(root.fallback, into);
    return into;
  };
  const noteUpgradesWithin = (
    was: SduiNode | undefined,
    now: SduiNode | undefined,
  ): void => {
    const previous = flatten(was);
    for (const [id, node] of flatten(now)) {
      const old = previous.get(id);
      if (old && old.type === node.type)
        noteUpgrade('components', id, node.type, old.v, node.v, old.props);
    }
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

  const screenPaths: string[] = [];
  if (before.id !== after.id) screenPaths.push('id');
  if (before.title !== after.title) screenPaths.push('title');
  if (before.slug !== after.slug) screenPaths.push('slug');
  for (const name of ['loading', 'empty', 'error', 'offline'] as const) {
    const left = before.states?.[name];
    const right = after.states?.[name];
    const comparable = (
      value: 'auto' | 'system' | SduiNode | undefined,
    ): string =>
      canonicalJson(
        value === undefined || typeof value === 'string'
          ? (value ?? null)
          : comparableTree(value),
      );
    if (comparable(left) !== comparable(right))
      screenPaths.push(`states.${name}`);
    noteUpgradesWithin(
      typeof left === 'object' ? left : undefined,
      typeof right === 'object' ? right : undefined,
    );
  }
  if (screenPaths.length > 0)
    changes.push({ kind: 'screen', paths: screenPaths });

  // Children that stayed under the same parent and slot, and changed order: the fewest that
  // explain the new order are the ones that moved, so reordering two cards is one move.
  const reordered = new Set<string>();
  const containers = new Map<
    string,
    { before: [number, string][]; after: [number, string][] }
  >();
  // A JSON pair, not a joined string: an id is any text, and must not be able to imitate the join.
  const containerOf = (place: NodePlace): string =>
    JSON.stringify([place.parentId, place.slot]);
  for (const [id, entry] of was) {
    const other = now.get(id);
    if (!other || containerOf(other.place) !== containerOf(entry.place))
      continue;
    const lists = containers.get(containerOf(entry.place)) ?? {
      before: [],
      after: [],
    };
    lists.before.push([entry.place.index, id]);
    lists.after.push([other.place.index, id]);
    containers.set(containerOf(entry.place), lists);
  }
  for (const lists of containers.values()) {
    const ordered = (list: [number, string][]): string[] =>
      list.sort((a, b) => a[0] - b[0]).map(([, id]) => id);
    const kept = stayedInOrder(ordered(lists.before), ordered(lists.after));
    for (const [, id] of lists.after) if (!kept.has(id)) reordered.add(id);
  }

  const differs = (a: unknown, b: unknown): boolean =>
    canonicalJson(a ?? null) !== canonicalJson(b ?? null);

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
      // Props of two different components are not comparable; everything else about the node is.
      changes.push({ kind: 'type', nodeId: id, from: old.type, to: node.type });
    } else {
      const left = upgrade('components', old.type, old.v, old.props);
      const right = upgrade('components', node.type, node.v, node.props);
      noteUpgrade('components', id, node.type, old.v, node.v, old.props);
      const paths = changedPaths(left.value, right.value);
      if (paths.length > 0 || left.pinned !== right.pinned)
        changes.push({ kind: 'content', nodeId: id, type: node.type, paths });
    }

    const actionsOf = (n: SduiNode): unknown =>
      Object.entries(n.actions ?? {}).map(([name, action]) => [
        name,
        comparableAction(action),
      ]);
    if (differs(actionsOf(old), actionsOf(node)))
      changes.push({ kind: 'actions', nodeId: id, type: node.type });
    for (const [name, action] of Object.entries(node.actions ?? {})) {
      const oldAction = own(old.actions, name);
      if (oldAction && oldAction.type === action.type)
        noteUpgrade(
          'actions',
          id,
          action.type,
          oldAction.v,
          action.v,
          oldAction.props,
          name,
        );
    }
    if (differs(old.visibility, node.visibility))
      changes.push({ kind: 'visibility', nodeId: id, type: node.type });
    if (
      differs(
        old.fallback && comparableTree(old.fallback),
        node.fallback && comparableTree(node.fallback),
      )
    )
      changes.push({ kind: 'fallback', nodeId: id, type: node.type });
    noteUpgradesWithin(old.fallback, node.fallback);
    if ((old.required ?? false) !== (node.required ?? false))
      changes.push({ kind: 'required', nodeId: id, type: node.type });
    if (differs(old.analytics, node.analytics))
      changes.push({ kind: 'analytics', nodeId: id, type: node.type });
  }

  for (const [id, entry] of was) {
    if (!now.has(id))
      changes.push({ kind: 'removed', nodeId: id, type: entry.node.type });
  }

  // Two documents can differ as bytes and not as screens — `props: {}` against no props at all.
  const unchanged = changes.length === 0 && catalogUpgrades.length === 0;
  return { unchanged, beforeId, afterId, changes, catalogUpgrades };
}

/**
 * Of ids that are in both lists, the largest set that kept its relative order — everything else
 * moved. The ids are unique and the two lists hold the same ones, so this is the longest
 * increasing run of "where each id used to be", found in `n log n` with no table: a list of ten
 * thousand siblings costs the same per element as one of ten.
 */
function stayedInOrder(
  before: readonly string[],
  after: readonly string[],
): Set<string> {
  const position = new Map(before.map((id, index) => [id, index]));
  const sequence = after.map((id) => position.get(id) as number);
  // tails[k] is the index in `sequence` of the smallest value ending an increasing run of k + 1.
  const tails: number[] = [];
  const previous = new Array<number>(sequence.length).fill(-1);
  sequence.forEach((value, at) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((sequence[tails[middle] as number] as number) < value)
        low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[at] = tails[low - 1] as number;
    tails[low] = at;
  });
  const kept = new Set<string>();
  for (
    let at = tails.length > 0 ? (tails[tails.length - 1] as number) : -1;
    at >= 0;
    at = previous[at] as number
  ) {
    kept.add(after[at] as string);
  }
  return kept;
}
