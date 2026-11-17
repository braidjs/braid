import {
  type MigrationContext,
  defaultMigrationContext,
} from '@braidlabs/skew';
import {
  type CatalogFallback,
  type ComponentDefinition,
  type SduiCatalog,
  PLACEHOLDER_TYPE,
} from './catalog.js';
import {
  type ConditionContext,
  evaluateCondition,
  hiddenByFlagsAlone,
} from './conditions.js';
import type { ClientManifest } from './manifest.js';
import { type CodeSteps, migrate } from './migrate.js';
import {
  type Condition,
  type Screen,
  type SduiAction,
  type SduiNode,
} from './model.js';
import { isRecord, own } from './internal.js';
import { pathWithin } from './paths.js';

/**
 * Projection — one authored screen, turned into what one binary can render.
 *
 * The server is always at least as new as the content it serves, and a device says exactly which
 * version of each component it was built with. So every node can be migrated to that version
 * through its contract: down for an older binary, up for a newer one. What a downgrade discards is
 * measured, so the result is labelled rather than passed off as exact.
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
 * Deterministic for a given clock: the same screen, catalog and manifest give the same result,
 * which is why a projection can be computed once per release and manifest and cached by their
 * ids. Only a catalog that uses `$now` reads the clock at all; pin `context` to fix it.
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
  /** Still to be evaluated per request — see {@link applyVisibility}. Never sent to a device. */
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
  /**
   * What a downgrade lost: prop paths in the component's newest shape — the one an author edits —
   * or `slots.<name>`.
   */
  readonly lossyPaths: readonly string[];
  /** Values that are the migration's guesses rather than what the author wrote. */
  readonly derivedPaths: readonly string[];
  /** Why it left rungs 1–2, in words an author can act on. */
  readonly reason?: string;
  /** The node that stands in for it, on rungs 3 and 4. */
  readonly replacedBy?: { readonly id: string; readonly type: string };
  /** Set on a stand-in's own entry: which node it is standing in for. */
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
  /** The clock `$now` reads. One instant is taken from it for the whole projection. */
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
      readonly blocked: readonly string[];
    }
  | { readonly ok: false; readonly reason: string; readonly hide?: true };

export function projectScreen(
  screen: Screen,
  catalog: SduiCatalog,
  manifest: ClientManifest,
  options: ProjectionOptions = {},
): ProjectionResult {
  const killed = new Set(options.unsupported ?? []);
  // One instant for the whole screen, so two nodes of one projection cannot disagree about "now".
  const instant = (options.context ?? defaultMigrationContext).now();
  const migrateOptions = {
    codeSteps: options.codeSteps,
    context: { ...(options.context ?? {}), now: () => instant },
  };

  const isRequired = (
    node: SduiNode,
    definition: ComponentDefinition | undefined = own(
      catalog.components,
      node.type,
    ),
  ): boolean =>
    node.required === true || definition?.fallback === 'fail-screen';

  /** Required nodes anywhere below these, through slots. */
  function requiredBelow(
    nodes: readonly SduiNode[],
    found: SduiNode[] = [],
  ): SduiNode[] {
    for (const node of nodes) {
      if (isRequired(node)) found.push(node);
      for (const children of Object.values(node.slots ?? {}))
        requiredBelow(children, found);
    }
    return found;
  }

  /**
   * A required node that went with a subtree that was not rendered. It blocks the screen exactly
   * as it would have if it had been reached and failed: being required is a property of the node,
   * not of the route projection happened to take to it.
   */
  function loseRequired(
    nodes: readonly SduiNode[],
    because: string,
    into: NodeReport[],
    blocked: string[],
  ): void {
    for (const lost of requiredBelow(nodes)) {
      blocked.push(lost.id);
      into.push({
        nodeId: lost.id,
        type: lost.type,
        outcome: 'omitted',
        rung: 5,
        authored: lost.v,
        lossyPaths: [],
        derivedPaths: [],
        reason: because,
        blocking: true,
      });
    }
  }

  const childrenOf = (node: SduiNode): SduiNode[] =>
    Object.values(node.slots ?? {}).flat();

  function projectAction(
    name: string,
    action: SduiAction,
  ): { action: ProjectedAction | null; report: ActionReport } {
    let candidate: SduiAction | undefined = action;
    let reason: string | undefined;
    let isFallback = false;
    while (candidate) {
      const definition = own(catalog.actions, candidate.type);
      const clientVersion = own(manifest.actions, candidate.type);
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
            ...(isRecord(props) && Object.keys(props).length > 0
              ? { props }
              : {}),
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
  function render(
    node: SduiNode,
    into: NodeReport[],
    extra: Partial<NodeReport> = {},
  ): Rendered {
    const definition = own(catalog.components, node.type);
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
    const clientVersion = own(manifest.components, node.type);
    if (clientVersion === undefined)
      return {
        ok: false,
        reason: `this app version has no "${node.type}" component`,
      };
    const contract = definition.contract;
    if (clientVersion > contract.current)
      return {
        ok: false,
        reason: `this app's "${node.type}" is v${clientVersion}, newer than the catalog's v${contract.current}`,
      };

    const migrated = migrate(
      contract,
      node.props ?? {},
      node.v,
      clientVersion,
      migrateOptions,
    );
    if (!migrated.ok) return { ok: false, reason: migrated.message };

    // What was lost, in the component's newest shape: that is the shape `criticalPaths` are
    // written in and the one an author sees. A node authored at an older version is lifted to the
    // newest first, so a field a later step renamed is still found under its current name.
    let lossy = [...migrated.lossyPaths];
    if (clientVersion < node.v && node.v < contract.current) {
      const lifted = migrate(
        contract,
        node.props ?? {},
        node.v,
        contract.current,
        migrateOptions,
      );
      const probe = lifted.ok
        ? migrate(
            contract,
            lifted.value,
            contract.current,
            clientVersion,
            migrateOptions,
          )
        : null;
      if (probe?.ok) lossy = [...probe.lossyPaths];
    }

    const keptSlots: [string, readonly SduiNode[]][] = [];
    const droppedSlots: [string, readonly SduiNode[]][] = [];
    for (const [slot, children] of Object.entries(node.slots ?? {})) {
      if ((own(definition.slots, slot)?.since ?? 1) > clientVersion) {
        if (children.length > 0) {
          lossy.push(`slots.${slot}`);
          droppedSlots.push([slot, children]);
        }
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

    const actions: [string, ProjectedAction][] = [];
    const actionReports: ActionReport[] = [];
    let disabled = false;
    for (const [name, action] of Object.entries(node.actions ?? {})) {
      const result = projectAction(name, action);
      if (result.report.outcome === 'hidden') {
        return {
          ok: false,
          hide: true,
          reason: `its "${name}" action cannot run on this app version (${result.report.reason}), and it is set to hide`,
        };
      }
      actionReports.push(result.report);
      if (result.action) actions.push([name, result.action]);
      else disabled = true;
    }

    // This node's entry goes in before its children's, so the report reads in document order —
    // but only once it is certain the node renders, hence the local list.
    const local: NodeReport[] = [];
    const blocked: string[] = [];
    for (const [slot, children] of droppedSlots) {
      loseRequired(
        children,
        `it is in the "${slot}" slot, which "${node.type}" v${clientVersion} does not have`,
        local,
        blocked,
      );
    }
    const slots: [string, ProjectedNode[]][] = [];
    for (const [slot, children] of keptSlots) {
      const projectedChildren: ProjectedNode[] = [];
      for (const child of children) {
        const result = ladder(child, local);
        for (const id of result.blocked) blocked.push(id);
        if (result.node) projectedChildren.push(result.node);
      }
      slots.push([slot, projectedChildren]);
    }

    const props = migrated.value;
    // `Object.fromEntries` defines keys; assigning them would let one named `__proto__` vanish.
    const projected: ProjectedNode = {
      id: node.id,
      type: node.type,
      v: clientVersion,
      ...(isRecord(props) && Object.keys(props).length > 0 ? { props } : {}),
      ...(slots.length > 0 ? { slots: Object.fromEntries(slots) } : {}),
      ...(actions.length > 0 ? { actions: Object.fromEntries(actions) } : {}),
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
    into.push({
      nodeId: node.id,
      type: node.type,
      outcome,
      rung: outcome === 'exact' ? 1 : 2,
      authored: node.v,
      rendered: clientVersion,
      lossyPaths: lossy,
      derivedPaths: migrated.derivedPaths,
      ...(actionReports.length > 0 ? { actions: actionReports } : {}),
      ...extra,
    });
    for (const entry of local) into.push(entry);
    return { ok: true, node: projected, blocked };
  }

  /** Rung 4: the node the catalog says stands in for this one, built from this one's props. */
  function catalogStandIn(
    node: SduiNode,
    fallback: CatalogFallback | undefined,
  ): SduiNode | 'placeholder' | null {
    if (fallback === 'placeholder') return 'placeholder';
    if (!isRecord(fallback)) return null;
    const target = own(catalog.components, fallback.type as string);
    const source = own(catalog.components, node.type);
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
    const props: [string, unknown][] = [];
    for (const [key, spec] of Object.entries(
      (fallback.props as Record<string, unknown>) ?? {},
    )) {
      if (isRecord(spec) && typeof spec['$from'] === 'string') {
        const value = spec['$from']
          .split('.')
          .reduce<unknown>(
            (scope, segment) =>
              isRecord(scope) ? own(scope, segment) : undefined,
            upgraded.value,
          );
        if (value !== undefined) props.push([key, value]);
      } else {
        props.push([key, spec]);
      }
    }
    return {
      id: node.id,
      type: fallback.type as string,
      v: target.contract.current,
      props: Object.fromEntries(props),
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

    const definition = own(catalog.components, node.type);
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
    // Whatever stands in for this node, the nodes authored inside it are not on the screen.
    const settle = (
      entry: NodeReport,
      rest: readonly NodeReport[],
      projected: ProjectedNode | null,
      blocked: readonly string[],
    ): { node: ProjectedNode | null; blocked: readonly string[] } => {
      const all = [...blocked];
      into.push(entry);
      for (const item of rest) into.push(item);
      if (!standIn)
        loseRequired(
          childrenOf(node),
          `it is inside "${node.id}", which this app version does not show as authored`,
          into,
          all,
        );
      return { node: projected, blocked: all };
    };

    if (node.fallback) {
      const local: NodeReport[] = [];
      const substitute = ladder(node.fallback, local, true);
      if (substitute.node) {
        const marked = local.map((entry, index) =>
          index === 0 ? { ...entry, fallbackFor: node.id } : entry,
        );
        return settle(
          {
            ...base,
            outcome: 'fallback-authored',
            rung: 3,
            replacedBy: { id: substitute.node.id, type: substitute.node.type },
          },
          marked,
          inherit(substitute.node),
          substitute.blocked,
        );
      }
    }
    if (standIn) return { node: null, blocked: [] };

    // `hide` means the author wants the control gone, not swapped for whatever the catalog has.
    const stand = direct.hide
      ? null
      : catalogStandIn(node, definition?.fallback);
    if (stand === 'placeholder') {
      // The placeholder carries nothing about what it replaces: a component's name can be a
      // secret, and a device that lacks the component has no use for it.
      return settle(
        {
          ...base,
          outcome: 'fallback-catalog',
          rung: 4,
          replacedBy: { id: node.id, type: PLACEHOLDER_TYPE },
        },
        [],
        inherit({ id: node.id, type: PLACEHOLDER_TYPE, v: 1 }),
        [],
      );
    }
    if (stand) {
      const local: NodeReport[] = [];
      const substitute = render(stand, local, { fallbackFor: node.id });
      if (substitute.ok) {
        return settle(
          {
            ...base,
            outcome: 'fallback-catalog',
            rung: 4,
            replacedBy: { id: substitute.node.id, type: substitute.node.type },
          },
          local,
          inherit(substitute.node),
          substitute.blocked,
        );
      }
    }

    const required = isRequired(node, definition);
    return settle(
      {
        ...base,
        outcome: 'omitted',
        rung: 5,
        ...(required ? { blocking: true } : {}),
      },
      [],
      null,
      required ? [node.id] : [],
    );
  }

  const report: NodeReport[] = [];
  const main = ladder(screen.root, report);

  // Authored states are projected like any node, but a state that cannot be rendered never blocks
  // the screen: the device falls back to the default for that state.
  const states: [string, 'auto' | 'system' | ProjectedNode][] = [];
  for (const name of ['loading', 'empty', 'error', 'offline'] as const) {
    const authored = screen.states?.[name];
    if (authored === undefined) continue;
    if (typeof authored === 'string') {
      states.push([name, authored]);
      continue;
    }
    const local: NodeReport[] = [];
    const projected = ladder(authored, local);
    for (const { blocking: _never, ...entry } of local) report.push(entry);
    // A state missing something required is not a state worth showing either.
    if (projected.node && projected.blocked.length === 0)
      states.push([name, projected.node]);
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
    ...(states.length > 0
      ? { states: Object.fromEntries(states) as ProjectedStates }
      : {}),
    report,
    blockedBy,
  };
}

export interface HiddenNode {
  readonly nodeId: string;
  /** `flag` when its flags alone are keeping it hidden; `visibility` for anything else. */
  readonly by: 'flag' | 'visibility';
}

export interface VisibleProjection {
  readonly root: ProjectedNode | null;
  readonly states?: ProjectedStates;
  readonly hidden: readonly HiddenNode[];
}

/**
 * The per-request half of delivery: prunes a projection by each node's condition and strips the
 * conditions, so rules, flag names and audiences never reach a device.
 *
 * It takes the whole projection, not just the root, because authored states carry conditions
 * too — and what comes back is the only form of a projection that is safe to serialise to a
 * device.
 */
export function applyVisibility(
  projection: Pick<ProjectionResult, 'root' | 'states'>,
  context: ConditionContext,
): VisibleProjection {
  const hidden: HiddenNode[] = [];
  const visit = (node: ProjectedNode): ProjectedNode | null => {
    const { visibility, slots, ...rest } = node;
    if (visibility && !evaluateCondition(visibility, context)) {
      hidden.push({
        nodeId: node.id,
        by: hiddenByFlagsAlone(visibility, context) ? 'flag' : 'visibility',
      });
      return null;
    }
    if (!slots) return rest;
    const kept = Object.entries(slots).map(
      ([slot, children]) =>
        [
          slot,
          children
            .map(visit)
            .filter((child): child is ProjectedNode => child !== null),
        ] as const,
    );
    return { ...rest, slots: Object.fromEntries(kept) };
  };

  const root = projection.root ? visit(projection.root) : null;
  const states: [string, 'auto' | 'system' | ProjectedNode][] = [];
  for (const [name, state] of Object.entries(projection.states ?? {})) {
    if (typeof state === 'string') {
      states.push([name, state as 'auto' | 'system']);
      continue;
    }
    const visible = visit(state as ProjectedNode);
    if (visible) states.push([name, visible]);
  }
  return {
    root,
    ...(states.length > 0
      ? { states: Object.fromEntries(states) as ProjectedStates }
      : {}),
    hidden,
  };
}
