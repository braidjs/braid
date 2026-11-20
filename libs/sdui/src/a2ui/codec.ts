import {
  PLACEHOLDER_TYPE,
  type ComponentDefinition,
  type SduiCatalog,
} from '../lib/catalog.js';
import { isRecord, own } from '../lib/internal.js';
import {
  NODE_ANNOTATIONS,
  type Screen,
  type SduiAction,
  type SduiNode,
  parseScreen,
} from '../lib/model.js';
import type { ProjectedAction, ProjectedNode } from '../lib/projection.js';
import { A2UI_CALL_ACTION, A2UI_EVENT_ACTION } from './basic.js';
import {
  A2uiError,
  type A2uiComponent,
  type A2uiMessage,
  type CreateSurface,
} from './messages.js';
import type { A2uiSurfaceState } from './surfaces.js';

/**
 * Between A2UI's flat component list and the SDUI tree.
 *
 * A2UI sends components as a flat list that reference each other by id, in any order, and a
 * renderer draws a placeholder for an id it has not been sent yet. The SDUI model is a tree of
 * versioned nodes with named slots. The two say the same things, and the catalog is what says how
 * one maps to the other: which props are slots (`Card.child`, `Row.children`, each of
 * `Tabs.tabs[].child`) and which hold actions (`Button.action`).
 *
 * - A dangling reference becomes a placeholder node (`sdui.placeholder`), and a placeholder is
 *   written back as a reference to nothing — which is how A2UI asks a renderer for a placeholder.
 * - A template — `children: { path, componentId }` — is the one child of its slot, with `repeat`.
 * - `@accessibility`, `@checks` and `@metadata` ride along as the node's `annotations`.
 * - An action is an `a2ui.event` (props: the event's `name`, `context`, `userMessage`) or an
 *   `a2ui.call` (props: `{ call }`). An action from an SDUI catalog — a CMS-authored `navigate` —
 *   is written as an event of its type's name, with its props as the context.
 * - The root is the component with id `root`, as A2UI requires.
 */

export const ROOT_ID = 'root';

/**
 * How many copies sharing may produce. Sharing is legitimate, but a component referenced from
 * many parents, each of them shared too, expands geometrically; past this the surface is refused.
 */
export const MAX_COPIES = 2_000;

type SlotKind = 'one' | 'many' | 'list';
interface SlotPlan {
  readonly slot: string;
  readonly kind: SlotKind;
  /** For `list`: the object field naming the child. */
  readonly key?: string;
}

/** Slots of components the catalog does not have: A2UI's two conventional names. */
const GENERIC_SLOTS: readonly SlotPlan[] = [
  { slot: 'child', kind: 'one' },
  { slot: 'children', kind: 'many' },
];

function definitionOf(
  catalog: SduiCatalog,
  type: string,
): ComponentDefinition | undefined {
  return own(catalog.components, type);
}

function slotPlan(catalog: SduiCatalog, type: string): readonly SlotPlan[] {
  const definition = definitionOf(catalog, type);
  if (!definition) return GENERIC_SLOTS;
  return Object.entries(definition.slots ?? {}).map(([slot, spec]) =>
    spec.a2ui
      ? { slot: spec.a2ui.list, kind: 'list' as const, key: spec.a2ui.key }
      : { slot, kind: spec.max === 1 ? ('one' as const) : ('many' as const) },
  );
}

/** The slot a `list` prop fills: the catalog's slot name, which need not be the prop's name. */
function slotNameOf(
  catalog: SduiCatalog,
  type: string,
  plan: SlotPlan,
): string {
  if (plan.kind !== 'list') return plan.slot;
  const definition = definitionOf(catalog, type);
  for (const [slot, spec] of Object.entries(definition?.slots ?? {}))
    if (spec.a2ui?.list === plan.slot) return slot;
  return plan.slot;
}

function actionProps(catalog: SduiCatalog, type: string): readonly string[] {
  const definition = definitionOf(catalog, type);
  return definition ? (definition.a2ui?.actions ?? []) : ['action'];
}

/**
 * The ids a component references as children, in order: what a renderer needs to walk a surface
 * without converting it.
 */
export function childReferences(
  component: A2uiComponent,
  catalog: SduiCatalog,
): string[] {
  const ids: string[] = [];
  for (const plan of slotPlan(catalog, component.component)) {
    const value = component[plan.slot];
    if (plan.kind === 'one' && typeof value === 'string') ids.push(value);
    if (plan.kind === 'many') {
      if (Array.isArray(value))
        for (const id of value) if (typeof id === 'string') ids.push(id);
      if (isRecord(value) && typeof value['componentId'] === 'string')
        ids.push(value['componentId']);
    }
    if (plan.kind === 'list' && Array.isArray(value))
      for (const item of value)
        if (isRecord(item) && typeof item[plan.key as string] === 'string')
          ids.push(item[plan.key as string] as string);
  }
  return ids;
}

export interface SurfaceConversion {
  /** `null` until the surface has a `root` component. */
  readonly screen: Screen | null;
  /** Ids referenced and not (yet) sent: each is a placeholder in the tree. */
  readonly dangling: readonly string[];
  /** Components sent and not reachable from the root. Kept on the surface; not in the tree. */
  readonly orphans: readonly string[];
}

export interface SurfaceToScreenOptions {
  readonly catalog: SduiCatalog;
  /**
   * The version each component was written at. Defaults to the catalog's newest — what an agent
   * authoring against the catalog's own id writes.
   */
  readonly versionOf?: (type: string) => number | undefined;
  readonly slug?: string;
}

/**
 * The SDUI screen an A2UI surface describes. Throws {@link A2uiError} (`VALIDATION_FAILED`) for
 * what a tree cannot be: a cycle, a component with two parents, a slot of the wrong shape.
 */
export function surfaceToScreen(
  surface: A2uiSurfaceState,
  options: SurfaceToScreenOptions,
): SurfaceConversion {
  const { catalog } = options;
  const where = (id: string): string =>
    `/components/${id.replace(/~/g, '~0').replace(/\//g, '~1')}`;
  const invalid = (message: string, id: string): never => {
    throw new A2uiError('VALIDATION_FAILED', message, where(id), surface.id);
  };
  if (!surface.components.has(ROOT_ID)) {
    return {
      screen: null,
      dangling: [],
      orphans: [...surface.components.keys()],
    };
  }
  const versionOf = (type: string): number =>
    options.versionOf?.(type) ??
    definitionOf(catalog, type)?.contract.current ??
    1;
  const visiting = new Set<string>();
  const reached = new Set<string>();
  const dangling: string[] = [];

  const child = (id: unknown, parent: string, at: string): SduiNode => {
    if (typeof id !== 'string' || id.length === 0)
      return invalid(`${at} must name a component id`, parent);
    if (visiting.has(id))
      return invalid(
        `"${id}" contains itself: the components form a cycle through "${parent}"`,
        parent,
      );
    const component = surface.components.get(id);
    if (!component) {
      if (!reached.has(id)) {
        reached.add(id);
        dangling.push(id);
        return { id, type: PLACEHOLDER_TYPE, v: 1 };
      }
      // A dangling id referenced twice is two placeholders; the second needs an id of its own.
      return {
        id: `${id}~${++copies}`,
        type: PLACEHOLDER_TYPE,
        v: 1,
        copyOf: id,
      };
    }
    // A component a second parent references is drawn again, as a copy: see `SduiNode.copyOf`.
    if (reached.has(id)) {
      if (++copies > MAX_COPIES)
        return invalid(
          `components are shared so often that the surface would expand past ${MAX_COPIES} copies`,
          parent,
        );
      return copyOf(node(component, true));
    }
    return node(component);
  };
  let copies = 0;
  /** Renames a subtree's ids so it can sit in a tree beside the original. */
  const copyOf = (original: SduiNode): SduiNode => {
    const suffix = `~${copies}`;
    const rename = (inner: SduiNode): SduiNode => ({
      ...inner,
      id: `${inner.id}${suffix}`,
      copyOf: inner.copyOf ?? inner.id,
      ...(inner.slots
        ? {
            slots: Object.fromEntries(
              Object.entries(inner.slots).map(([slot, children]) => [
                slot,
                children.map(rename),
              ]),
            ),
          }
        : {}),
      ...(inner.fallback ? { fallback: rename(inner.fallback) } : {}),
    });
    return rename(original);
  };

  const node = (component: A2uiComponent, again = false): SduiNode => {
    const { id, component: type } = component;
    visiting.add(id);
    if (!again) reached.add(id);
    const catalogId = component['@catalogId'];
    if (catalogId !== undefined && catalogId !== surface.catalogId)
      invalid(
        `"${id}" names the catalog "${String(catalogId)}"; a surface drawn from more than one catalog is not supported here`,
        id,
      );
    const taken = new Set<string>(['id', 'component', '@catalogId']);
    const props: Record<string, unknown> = {};
    const slots: [string, SduiNode[]][] = [];
    const actions: [string, SduiAction][] = [];
    const annotations: [string, unknown][] = [];

    for (const plan of slotPlan(catalog, type)) {
      const value = component[plan.slot];
      if (value === undefined) continue;
      const slot = slotNameOf(catalog, type, plan);
      if (plan.kind === 'one') {
        taken.add(plan.slot);
        slots.push([slot, [child(value, id, plan.slot)]]);
      } else if (plan.kind === 'many') {
        taken.add(plan.slot);
        if (Array.isArray(value))
          slots.push([
            slot,
            value.map((ref, index) => child(ref, id, `${plan.slot}[${index}]`)),
          ]);
        else if (
          isRecord(value) &&
          typeof value['path'] === 'string' &&
          Object.keys(value).length === 2
        )
          slots.push([
            slot,
            [
              {
                ...child(value['componentId'], id, `${plan.slot}.componentId`),
                repeat: value['path'],
              },
            ],
          ]);
        else
          invalid(
            `${plan.slot} must be a list of ids or a template { path, componentId }`,
            id,
          );
      } else {
        // The list stays a prop; each item gives up the field that named its child to the slot.
        if (!Array.isArray(value)) continue;
        taken.add(plan.slot);
        const key = plan.key as string;
        const children: SduiNode[] = [];
        props[plan.slot] = value.map((item, index) => {
          if (!isRecord(item))
            return invalid(`${plan.slot}[${index}] must be an object`, id);
          children.push(child(item[key], id, `${plan.slot}[${index}].${key}`));
          return Object.fromEntries(
            Object.entries(item).filter(([field]) => field !== key),
          );
        });
        slots.push([slot, children]);
      }
    }
    for (const name of actionProps(catalog, type)) {
      const value = component[name];
      if (value === undefined) continue;
      taken.add(name);
      actions.push([name, fromA2uiAction(value, id, name, invalid)]);
    }
    for (const key of NODE_ANNOTATIONS) {
      if (component[key] === undefined) continue;
      taken.add(key);
      annotations.push([key, component[key]]);
    }
    for (const [key, value] of Object.entries(component))
      if (!taken.has(key)) props[key] = value;
    visiting.delete(id);
    return {
      id,
      type,
      v: versionOf(type),
      ...(Object.keys(props).length > 0 ? { props } : {}),
      ...(slots.length > 0 ? { slots: Object.fromEntries(slots) } : {}),
      ...(actions.length > 0 ? { actions: Object.fromEntries(actions) } : {}),
      ...(annotations.length > 0
        ? { annotations: Object.fromEntries(annotations) }
        : {}),
    };
  };

  const root = node(surface.components.get(ROOT_ID) as A2uiComponent);
  const raw = {
    id: surface.id,
    slug: options.slug ?? surface.id,
    root,
    ...(Object.keys(surface.dataModel).length > 0
      ? { data: surface.dataModel }
      : {}),
  };
  let screen: Screen;
  try {
    screen = parseScreen(raw);
  } catch (error) {
    throw new A2uiError(
      'VALIDATION_FAILED',
      (error as Error).message.replace(/^sdui screen: /, ''),
      '',
      surface.id,
    );
  }
  const orphans = [...surface.components.keys()].filter(
    (id) => !reached.has(id),
  );
  return { screen, dangling, orphans };
}

function fromA2uiAction(
  value: unknown,
  id: string,
  name: string,
  invalid: (message: string, id: string) => never,
): SduiAction {
  if (
    isRecord(value) &&
    isRecord(value['event']) &&
    Object.keys(value).length === 1
  ) {
    const event = value['event'];
    if (typeof event['name'] !== 'string' || event['name'].length === 0)
      return invalid(`${name}.event.name must be a non-empty string`, id);
    return { type: A2UI_EVENT_ACTION, v: 1, props: event };
  }
  if (
    isRecord(value) &&
    isRecord(value['functionCall']) &&
    Object.keys(value).length === 1
  )
    return {
      type: A2UI_CALL_ACTION,
      v: 1,
      props: { call: value['functionCall'] },
    };
  return invalid(
    `${name} must be an action: { event: { name, context } } or { functionCall }`,
    id,
  );
}

function toA2uiAction(
  action: ProjectedAction | SduiAction,
): Record<string, unknown> {
  if (action.type === A2UI_EVENT_ACTION) return { event: action.props ?? {} };
  if (action.type === A2UI_CALL_ACTION)
    return { functionCall: (action.props ?? {})['call'] };
  return {
    event: {
      name: action.type,
      ...(action.props && Object.keys(action.props).length > 0
        ? { context: action.props }
        : {}),
    },
  };
}

/**
 * What a disabled control is given in A2UI, which has no "disabled" of its own but disables any
 * checkable control whose checks fail: a check on a path no data model has, which is never true.
 */
export const UNAVAILABLE_CHECK = Object.freeze({
  condition: { '@path': '/sdui:unavailable' },
  message: 'Not available in this version of the app',
});
/** The event a disabled control's action prop is written as, so the component stays valid. */
export const UNAVAILABLE_EVENT = 'sdui.unavailable';

export interface ToComponentsOptions {
  readonly catalog: SduiCatalog;
}

/**
 * A tree — authored, or projected for one device — as A2UI components, root first. Visibility
 * must already be applied (`applyVisibility`); what is left of it is not sent.
 */
export function treeToComponents(
  root: ProjectedNode | SduiNode,
  options: ToComponentsOptions,
): A2uiComponent[] {
  const { catalog } = options;
  const idOf = (node: ProjectedNode | SduiNode, isRoot: boolean): string =>
    isRoot ? ROOT_ID : node.id;
  if (root.id !== ROOT_ID) {
    // Renaming the root must not collide with a node that already holds the name.
    const clash = (node: ProjectedNode | SduiNode): boolean =>
      (
        Object.values(node.slots ?? {}) as readonly (
          | ProjectedNode
          | SduiNode
        )[][]
      ).some((children) => children.some((c) => c.id === ROOT_ID || clash(c)));
    if (clash(root))
      throw new A2uiError(
        'VALIDATION_FAILED',
        `a node other than the root is named "${ROOT_ID}"`,
        '/components',
      );
  }

  const visit = (node: ProjectedNode | SduiNode, isRoot: boolean): string => {
    // A copy is written as a reference to the component it copies, which is sent once.
    if (node.copyOf !== undefined) return node.copyOf;
    const id = idOf(node, isRoot);
    if (node.type === PLACEHOLDER_TYPE) return id; // referenced, never sent: the renderer's placeholder
    const component: Record<string, unknown> = { id, component: node.type };
    const props = { ...(node.props ?? {}) };
    for (const plan of slotPlan(catalog, node.type)) {
      const slot = slotNameOf(catalog, node.type, plan);
      const children = own(node.slots, slot);
      if (plan.kind === 'one') {
        // An empty single slot still names a child — one that does not exist, so a placeholder.
        component[plan.slot] =
          children && children[0] ? visit(children[0], false) : `${id}~${slot}`;
      } else if (plan.kind === 'many') {
        if (children === undefined) continue;
        const template =
          children.length === 1 && children[0]?.repeat !== undefined
            ? children[0]
            : null;
        component[plan.slot] = template
          ? { path: template.repeat, componentId: visit(template, false) }
          : children.map((c) => visit(c, false));
      } else {
        const list = props[plan.slot];
        if (!Array.isArray(list)) continue;
        const key = plan.key as string;
        props[plan.slot] = list.map((item, index) => ({
          ...(isRecord(item) ? item : {}),
          [key]: children?.[index]
            ? visit(children[index] as ProjectedNode, false)
            : `${id}~${slot}~${index}`,
        }));
      }
    }
    Object.assign(component, props);
    for (const [name, action] of Object.entries(node.actions ?? {}))
      component[name] = toA2uiAction(action);
    const annotations: Record<string, unknown> = {
      ...(node.annotations ?? {}),
    };
    if ((node as ProjectedNode).disabled) {
      const checks = Array.isArray(annotations['@checks'])
        ? annotations['@checks']
        : [];
      annotations['@checks'] = [...checks, UNAVAILABLE_CHECK];
      for (const name of actionProps(catalog, node.type))
        if (component[name] === undefined)
          component[name] = { event: { name: UNAVAILABLE_EVENT } };
    }
    Object.assign(component, annotations);
    built.set(id, component as A2uiComponent);
    return id;
  };
  // Pre-order — a parent before its children — so a renderer reading in order meets the root
  // first. Children finish building before their parent does, hence the separate order.
  const built = new Map<string, A2uiComponent>();
  const order: string[] = [];
  const reach = (node: ProjectedNode | SduiNode, isRoot: boolean): void => {
    if (node.copyOf !== undefined) return;
    if (node.type !== PLACEHOLDER_TYPE) order.push(idOf(node, isRoot));
    for (const children of Object.values(node.slots ?? {}) as (
      | ProjectedNode
      | SduiNode
    )[][])
      for (const c of children) reach(c, false);
  };
  reach(root, true);
  visit(root, true);
  return order.map((id) => built.get(id) as A2uiComponent);
}

export interface SurfaceMessagesInput {
  readonly surfaceId: string;
  readonly catalogId: string;
  readonly root: ProjectedNode | SduiNode;
  readonly dataModel?: Readonly<Record<string, unknown>>;
  readonly sendDataModel?: boolean;
  readonly catalog: SduiCatalog;
}

/** One `createSurface` carrying the components and the data model — v1.0 allows them inline. */
export function surfaceMessages(input: SurfaceMessagesInput): A2uiMessage[] {
  const createSurface: CreateSurface = {
    surfaceId: input.surfaceId,
    catalogId: input.catalogId,
    ...(input.sendDataModel ? { sendDataModel: true } : {}),
    components: treeToComponents(input.root, { catalog: input.catalog }),
    ...(input.dataModel && Object.keys(input.dataModel).length > 0
      ? { dataModel: input.dataModel }
      : {}),
  };
  return [{ version: '1.0', createSurface }];
}
