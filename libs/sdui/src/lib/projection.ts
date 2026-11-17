import type { MigrationContext } from '@braidlabs/skew';
import {
  type CatalogFallback,
  type SduiCatalog,
  PLACEHOLDER_TYPE,
} from './catalog.js';
import { type ConditionContext, evaluateCondition } from './conditions.js';
import type { ClientManifest } from './manifest.js';
import { type CodeSteps, migrate, pathWithin } from './migrate.js';
import {
  type Condition,
  type Screen,
  type SduiAction,
  type SduiNode,
  isRecord,
} from './model.js';

/**
 * Projection — one authored screen, turned into what one binary can render.
 *
 * The server is always at least as new as the content it serves, and a device says exactly which
 * version of each component it was built with. So every node can be migrated to that version
 * through its contract: down for an older binary, up for a newer one. What a downgrade discards is
 * computed, so the result is labelled rather than passed off as exact.
 *
 * Where a node cannot be migrated honestly — the device lacks the component, a step cannot be
 * inverted, a critical field would be lost — it is never guessed at. It goes down the ladder:
 *
 * 1. exact render
 * 2. projected render (down or up)
 * 3. the node's authored fallback
 * 4. the component's catalog fallback
 * 5. omit — unless the node is required, which blocks the screen for that device
 *
 * Rungs 6–9 (an earlier release, the device's cache, the bundled baseline, native) belong to the
 * delivery API and the client; a `blocked` result is how this function hands over to them.
 *
 * Pure: the same screen, catalog and manifest always give the same result, which is why a
 * projection can be computed once per release and manifest and cached by their ids.
 */

export type NodeOutcome =
  | 'exact'
  | 'upgraded'
  | 'downgraded'
  | 'fallback-authored'
  | 'fallback-catalog'
  | 'omitted';

/**
 * - `exact` — renders as designed.
 * - `degraded` — renders, with something left out or an action disabled.
 * - `fallback` — at least one node was replaced or omitted.
 * - `blocked` — a required node cannot be rendered; this device must not be shown this screen.
 */
export type ProjectionOutcome = 'exact' | 'degraded' | 'fallback' | 'blocked';

export type ActionOutcome =
  | 'exact'
  | 'upgraded'
  | 'downgraded'
  | 'fallback'
  | 'disabled'
  | 'hidden';

export interface ProjectedAction {
  readonly type: string;
  readonly v: number;
  readonly props?: Readonly<Record<string, unknown>>;
}

/** A node as it goes on the wire: at the client's version, with nothing authoring-only left. */
export interface ProjectedNode {
  readonly id: string;
  readonly type: string;
  readonly v: number;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly slots?: Readonly<Record<string, readonly ProjectedNode[]>>;
  readonly actions?: Readonly<Record<string, ProjectedAction>>;
  /** An action this control needs is not supported on this device. */
  readonly disabled?: true;
  /** Still to be evaluated per request — see {@link applyVisibility}. */
  readonly visibility?: Condition;
  readonly analytics?: { readonly name?: string };
}

export interface ActionReport {
  readonly name: string;
  readonly type: string;
  readonly outcome: ActionOutcome;
  readonly lossyPaths: readonly string[];
  readonly reason?: string;
}

export interface NodeReport {
  readonly nodeId: string;
  readonly type: string;
  readonly outcome: NodeOutcome;
  /** How far down the ladder this node went, 1–5. */
  readonly rung: 1 | 2 | 3 | 4 | 5;
  /** The version it was authored at. */
  readonly authored: number;
  /** The version it was rendered at, when it was rendered as itself. */
  readonly rendered?: number;
  /** What a downgrade discarded: prop paths, or `slots.<name>`. */
  readonly lossyPaths: readonly string[];
  /** Values that are the migration's guesses rather than what the author wrote. */
  readonly derivedPaths: readonly string[];
  /** Why it left rungs 1–2, in words an author can act on. */
  readonly reason?: string;
  /** The node that stands in for it, on rungs 3 and 4. */
  readonly replacedBy?: { readonly id: string; readonly type: string };
  /** Set on a fallback node's own entry: which node it is standing in for. */
  readonly fallbackFor?: string;
  /** True when this node is why the screen is blocked. */
  readonly blocking?: boolean;
  readonly actions?: readonly ActionReport[];
}

export interface ProjectedStates {
  readonly loading?: 'auto' | ProjectedNode;
  readonly empty?: ProjectedNode;
  readonly error?: 'system' | ProjectedNode;
  readonly offline?: 'system' | ProjectedNode;
}

export interface ProjectionResult {
  readonly outcome: ProjectionOutcome;
  /** `null` when blocked, or when the root itself was omitted. */
  readonly root: ProjectedNode | null;
  readonly states?: ProjectedStates;
  /** One entry per authored node that was reached, in document order. */
  readonly report: readonly NodeReport[];
  /** Ids of the required nodes that could not be rendered. Empty unless `blocked`. */
  readonly blockedBy: readonly string[];
}

export interface ProjectionOptions {
  readonly codeSteps?: CodeSteps;
  readonly context?: MigrationContext;
  /**
   * Component types to treat as absent on this device whatever its manifest says — the operator's
   * kill switch for a native component that misbehaves in one build. They take their fallbacks
   * through ordinary projection, with no release and no app update.
   */
  readonly unsupported?: readonly string[];
}

type Rendered =
  | {
      readonly ok: true;
      readonly node: ProjectedNode;
      readonly report: NodeReport;
      readonly blocked: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

export function projectScreen(
  screen: Screen,
  catalog: SduiCatalog,
  manifest: ClientManifest,
  options: ProjectionOptions = {},
): ProjectionResult {
  const report: NodeReport[] = [];
  const killed = new Set(options.unsupported ?? []);
  const migrateOptions = {
    codeSteps: options.codeSteps,
    context: options.context,
  };

  function projectAction(
    name: string,
    action: SduiAction,
  ): { action: ProjectedAction | null; report: ActionReport } {
    let candidate: SduiAction | undefined = action;
    let reason: string | undefined;
    let isFallback = false;
    while (candidate) {
      const definition = catalog.actions?.[candidate.type];
      const clientVersion = manifest.actions?.[candidate.type];
      const attempt:
        | string
        | {
            action: ProjectedAction;
            outcome: ActionOutcome;
            lossy: readonly string[];
          } = (() => {
        if (!definition)
          return `"${candidate.type}" is not an action in the catalog`;
        if (clientVersion === undefined)
          return `this app version has no "${candidate.type}" action`;
        if (clientVersion > definition.contract.current)
          return `this app's "${candidate.type}" is v${clientVersion}, newer than the catalog's v${definition.contract.current}`;
        const migrated = migrate(
          definition.contract,
          candidate.props ?? {},
          candidate.v,
          clientVersion,
          migrateOptions,
        );
        if (!migrated.ok) return migrated.message;
        const props = migrated.value as Record<string, unknown>;
        return {
          action: {
            type: candidate.type,
            v: clientVersion,
            ...(Object.keys(props).length > 0 ? { props } : {}),
          },
          outcome: isFallback
            ? 'fallback'
            : clientVersion === candidate.v
              ? 'exact'
              : clientVersion > candidate.v
                ? 'upgraded'
                : 'downgraded',
          lossy: migrated.lossyPaths,
        };
      })();
      if (typeof attempt !== 'string') {
        return {
          action: attempt.action,
          report: {
            name,
            type: attempt.action.type,
            outcome: attempt.outcome,
            lossyPaths: attempt.lossy,
            ...(reason ? { reason } : {}),
          },
        };
      }
      reason ??= attempt;
      candidate = candidate.fallback;
      isFallback = true;
    }
    return {
      action: null,
      report: {
        name,
        type: action.type,
        outcome: action.unsupported === 'hide' ? 'hidden' : 'disabled',
        lossyPaths: [],
        reason: reason as string,
      },
    };
  }

  /** Rungs 1 and 2: this node, as itself, at the client's version — or why not. */
  function render(node: SduiNode, into: NodeReport[]): Rendered {
    const definition = catalog.components[node.type];
    if (!definition)
      return {
        ok: false,
        reason: `"${node.type}" is not a component in the catalog`,
      };
    if (killed.has(node.type))
      return {
        ok: false,
        reason: `"${node.type}" is switched off for this app version`,
      };
    const clientVersion = manifest.components[node.type];
    if (clientVersion === undefined)
      return {
        ok: false,
        reason: `this app version has no "${node.type}" component`,
      };
    const current = definition.contract.current;
    if (clientVersion > current)
      return {
        ok: false,
        reason: `this app's "${node.type}" is v${clientVersion}, newer than the catalog's v${current}`,
      };

    const migrated = migrate(
      definition.contract,
      node.props ?? {},
      node.v,
      clientVersion,
      migrateOptions,
    );
    if (!migrated.ok) return { ok: false, reason: migrated.message };

    const lossy = [...migrated.lossyPaths];
    const keptSlots: [string, readonly SduiNode[]][] = [];
    for (const [slot, children] of Object.entries(node.slots ?? {})) {
      const since = definition.slots?.[slot]?.since ?? 1;
      if (since > clientVersion) {
        if (children.length > 0) lossy.push(`slots.${slot}`);
      } else {
        keptSlots.push([slot, children]);
      }
    }

    const critical = lossy.find((path) =>
      (definition.criticalPaths ?? []).some((c) => pathWithin(path, c)),
    );
    if (critical !== undefined) {
      return {
        ok: false,
        reason: `"${node.type}" v${clientVersion} cannot carry "${critical}", which must not be lost`,
      };
    }

    const actions: Record<string, ProjectedAction> = {};
    const actionReports: ActionReport[] = [];
    let disabled = false;
    for (const [name, action] of Object.entries(node.actions ?? {})) {
      const result = projectAction(name, action);
      if (result.report.outcome === 'hidden') {
        return {
          ok: false,
          reason: `its "${name}" action cannot run on this app version (${result.report.reason}), and it is set to hide`,
        };
      }
      actionReports.push(result.report);
      if (result.action) actions[name] = result.action;
      else disabled = true;
    }

    // This node's entry goes in before its children's, so the report reads in document order —
    // but only once it is certain the node renders, hence the local list.
    const local: NodeReport[] = [];
    const blocked: string[] = [];
    const slots: Record<string, ProjectedNode[]> = {};
    for (const [slot, children] of keptSlots) {
      const projectedChildren: ProjectedNode[] = [];
      for (const child of children) {
        const result = ladder(child, local);
        blocked.push(...result.blocked);
        if (result.node) projectedChildren.push(result.node);
      }
      slots[slot] = projectedChildren;
    }

    const props = migrated.value as Record<string, unknown>;
    const projected: ProjectedNode = {
      id: node.id,
      type: node.type,
      v: clientVersion,
      ...(isRecord(props) && Object.keys(props).length > 0 ? { props } : {}),
      ...(Object.keys(slots).length > 0 ? { slots } : {}),
      ...(Object.keys(actions).length > 0 ? { actions } : {}),
      ...(disabled ? { disabled: true as const } : {}),
      ...(node.visibility ? { visibility: node.visibility } : {}),
      ...(node.analytics ? { analytics: node.analytics } : {}),
    };
    const outcome: NodeOutcome =
      clientVersion === node.v
        ? 'exact'
        : clientVersion > node.v
          ? 'upgraded'
          : 'downgraded';
    const entry: NodeReport = {
      nodeId: node.id,
      type: node.type,
      outcome,
      rung: outcome === 'exact' ? 1 : 2,
      authored: node.v,
      rendered: clientVersion,
      lossyPaths: lossy,
      derivedPaths: migrated.derivedPaths,
      ...(actionReports.length > 0 ? { actions: actionReports } : {}),
    };
    into.push(entry, ...local);
    return { ok: true, node: projected, report: entry, blocked };
  }

  /** Rung 4: the node the catalog says stands in for this one, built from this one's props. */
  function catalogStandIn(
    node: SduiNode,
    fallback: CatalogFallback | undefined,
  ): SduiNode | 'placeholder' | null {
    if (fallback === 'placeholder') return 'placeholder';
    if (!isRecord(fallback)) return null;
    const target = catalog.components[fallback.type as string];
    const source = catalog.components[node.type];
    if (!target || !source) return null;
    // `$from` paths are written against the component's newest shape, so read them from there.
    const upgraded =
      node.v > source.contract.current
        ? null
        : migrate(
            source.contract,
            node.props ?? {},
            node.v,
            source.contract.current,
            migrateOptions,
          );
    if (!upgraded?.ok) return null;
    const props: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(
      (fallback.props as Record<string, unknown>) ?? {},
    )) {
      if (isRecord(spec) && typeof spec['$from'] === 'string') {
        const value = spec['$from']
          .split('.')
          .reduce<unknown>(
            (scope, segment) => (isRecord(scope) ? scope[segment] : undefined),
            upgraded.value,
          );
        if (value !== undefined) props[key] = value;
      } else {
        props[key] = spec;
      }
    }
    return {
      id: node.id,
      type: fallback.type as string,
      v: target.contract.current,
      props,
    };
  }

  /** The whole ladder for one node. `standIn` stops at rung 3: a fallback has no catalog fallback of its own. */
  function ladder(
    node: SduiNode,
    into: NodeReport[],
    standIn = false,
  ): { node: ProjectedNode | null; blocked: readonly string[] } {
    const direct = render(node, into);
    if (direct.ok) return { node: direct.node, blocked: direct.blocked };

    const definition = catalog.components[node.type];
    const base = {
      nodeId: node.id,
      type: node.type,
      authored: node.v,
      lossyPaths: [],
      derivedPaths: [],
      reason: direct.reason,
    };
    const inherit = (projected: ProjectedNode): ProjectedNode => {
      // A stand-in is shown under the same conditions as the node it stands in for.
      if (!node.visibility) return projected;
      const visibility: Condition = projected.visibility
        ? { all: [node.visibility, projected.visibility] }
        : node.visibility;
      return { ...projected, visibility };
    };

    if (node.fallback) {
      const local: NodeReport[] = [];
      const substitute = ladder(node.fallback, local, true);
      if (substitute.node) {
        into.push({
          ...base,
          outcome: 'fallback-authored',
          rung: 3,
          replacedBy: { id: substitute.node.id, type: substitute.node.type },
        });
        into.push(
          ...local.map((entry, index) =>
            index === 0 ? { ...entry, fallbackFor: node.id } : entry,
          ),
        );
        return { node: inherit(substitute.node), blocked: substitute.blocked };
      }
    }
    if (standIn) return { node: null, blocked: [] };

    const stand = catalogStandIn(node, definition?.fallback);
    if (stand === 'placeholder') {
      into.push({
        ...base,
        outcome: 'fallback-catalog',
        rung: 4,
        replacedBy: { id: node.id, type: PLACEHOLDER_TYPE },
      });
      return {
        node: inherit({
          id: node.id,
          type: PLACEHOLDER_TYPE,
          v: 1,
          props: { for: node.type },
        }),
        blocked: [],
      };
    }
    if (stand) {
      const local: NodeReport[] = [];
      const substitute = render(stand, local);
      if (substitute.ok) {
        into.push({
          ...base,
          outcome: 'fallback-catalog',
          rung: 4,
          replacedBy: { id: substitute.node.id, type: substitute.node.type },
        });
        return { node: inherit(substitute.node), blocked: substitute.blocked };
      }
    }

    const required =
      node.required === true || definition?.fallback === 'fail-screen';
    into.push({
      ...base,
      outcome: 'omitted',
      rung: 5,
      ...(required ? { blocking: true } : {}),
    });
    return { node: null, blocked: required ? [node.id] : [] };
  }

  const main = ladder(screen.root, report);

  // Authored states are projected like any node, but a state that cannot be rendered never blocks
  // the screen: the device falls back to the default for that state.
  const states: { -readonly [K in keyof ProjectedStates]: ProjectedStates[K] } =
    {};
  for (const name of ['loading', 'empty', 'error', 'offline'] as const) {
    const authored = screen.states?.[name];
    if (authored === undefined) continue;
    if (typeof authored === 'string') {
      (states as Record<string, unknown>)[name] = authored;
      continue;
    }
    const projected = ladder(authored, report).node;
    if (projected) (states as Record<string, unknown>)[name] = projected;
  }

  const blockedBy = [...main.blocked];
  const outcome: ProjectionOutcome =
    blockedBy.length > 0
      ? 'blocked'
      : report.some((entry) => entry.rung >= 3)
        ? 'fallback'
        : report.some(
              (entry) =>
                entry.lossyPaths.length > 0 ||
                entry.actions?.some(
                  (a) => a.outcome === 'disabled' || a.lossyPaths.length > 0,
                ),
            )
          ? 'degraded'
          : 'exact';

  return {
    outcome,
    root: blockedBy.length > 0 ? null : main.node,
    ...(Object.keys(states).length > 0 ? { states } : {}),
    report,
    blockedBy,
  };
}

export interface HiddenNode {
  readonly nodeId: string;
  /** `flag` when a flag alone is keeping it hidden; `visibility` for anything else. */
  readonly by: 'flag' | 'visibility';
}

/**
 * The per-request half of delivery: prunes a projected tree by each node's condition, and strips
 * the conditions, so rules and audiences never reach a device.
 */
export function applyVisibility(
  root: ProjectedNode | null,
  context: ConditionContext,
): { root: ProjectedNode | null; hidden: HiddenNode[] } {
  const hidden: HiddenNode[] = [];
  const visit = (node: ProjectedNode): ProjectedNode | null => {
    const { visibility, slots, ...rest } = node;
    if (visibility && !evaluateCondition(visibility, context)) {
      hidden.push({
        nodeId: node.id,
        by: evaluateCondition(visibility, context, { assumeFlags: true })
          ? 'flag'
          : 'visibility',
      });
      return null;
    }
    if (!slots) return rest;
    const kept: Record<string, ProjectedNode[]> = {};
    for (const [slot, children] of Object.entries(slots)) {
      kept[slot] = children
        .map(visit)
        .filter((child): child is ProjectedNode => child !== null);
    }
    return { ...rest, slots: kept };
  };
  return { root: root ? visit(root) : null, hidden };
}
