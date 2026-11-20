import type { SduiCatalog } from '../lib/catalog.js';
import { isRecord } from '../lib/internal.js';
import { a2uiBasicCatalog } from '../a2ui/basic.js';
import type { A2uiComponent, A2uiRendererMessage } from '../a2ui/messages.js';
import {
  type A2uiSurfaceState,
  formatPointer,
  resolvePointer,
} from '../a2ui/surfaces.js';
import { BASIC_COMPONENTS } from './components.js';
import {
  type DrawBudget,
  DRAW_LIMITS,
  type EvaluationScope,
  type Evaluator,
  ROOT_SCOPE,
  type UrlCheck,
  type UrlPolicy,
  type UrlUse,
  checkUrl,
} from './evaluate.js';
import { layoutCost } from './layout.js';
import { type MarkdownResult, markdown } from './markdown.js';
import { type View, type ViewElement, h } from './view.js';

/**
 * Drawing a surface: from its `root`, each component through the implementation registered for its
 * type — the host's own, or the basic catalog's — into a view.
 *
 * The same function draws in a browser and on a server, so a prerendered page and the renderer
 * that takes it over produce the same markup. Everything content controls goes through the
 * context below: values are evaluated, URLs checked, actions dispatched as A2UI messages. A
 * component implementation never sees the data model, the message channel or the page.
 */

/** What a component implementation is given. */
export interface RenderContext {
  readonly surfaceId: string;
  readonly id: string;
  /**
   * Unique to this drawing of the component: its place in the tree, template items included.
   * What a component keys its own state and its generated DOM ids by.
   */
  readonly key: string;
  readonly component: A2uiComponent;
  readonly scope: EvaluationScope;
  /** The raw prop, as sent. */
  raw(name: string): unknown;
  /** The prop, evaluated. */
  value(name: string): unknown;
  text(name: string): string;
  boolean(name: string): boolean;
  /** Any dynamic value — a tab's title, an option's label — evaluated as text. */
  textOf(value: unknown): string;
  /** A single-child prop (`child`, `trigger`), drawn. */
  child(name: string): View | null;
  /** A list-of-children prop (`children`), drawn — a template once per item. */
  children(name: string): View[];
  /** Draws a child by id, as `Tabs` does for each tab. */
  childById(id: unknown): View | null;
  /**
   * A prop an input writes back. Bound with `@path`, writing updates the data model; a literal is
   * kept as the input's own state, so typing into it is not undone by the next redraw.
   */
  bind(name: string): { readonly value: unknown; write(value: unknown): void };
  /** The component's `@checks`, evaluated. */
  checks(): { readonly valid: boolean; readonly messages: readonly string[] };
  /** The handler for an action prop, or `null` when there is none. Refuses while checks fail. */
  action(name: string): (() => void) | null;
  /** A URL prop, checked against the page's policy. */
  url(name: string, use: UrlUse): UrlCheck;
  markdown(text: string): MarkdownResult;
  /**
   * How many of `count` repeated parts — tabs, options — may be drawn, counted against the
   * draw's budget like components.
   */
  allow(count: number): number;
  /** State the renderer keeps for a component between draws — the open tab. */
  local<T>(name: string, initial: T): [T, (value: T) => void];
}

export type ComponentRenderer = (context: RenderContext) => View;

/**
 * A host's implementation of a component type. The point of rendering into the host's page is that
 * its components can be the host's own:
 *
 * - a function, building a view like the built-in components do;
 * - `{ element }` — one of the host's custom elements. It gets the evaluated props as its `a2ui`
 *   property (and the scalar ones as attributes), its children as light-DOM children with `slot`
 *   set to the prop's name, and `events` maps a DOM event it fires to the action prop to run;
 * - `{ fragment }` — a Braid fragment: another team's independently deployed app, mounted with
 *   `<fragment-slot>` in contract mode and given the props as its `props`. `events` maps a
 *   `braid:event` type it emits to the action prop to run, with the event's detail added to the
 *   action's context as `detail`.
 */
export type ComponentOverride =
  | ComponentRenderer
  | {
      readonly element: string;
      readonly events?: Readonly<Record<string, string>>;
    }
  | {
      readonly fragment: {
        readonly name: string;
        readonly entry: string;
        readonly adapter?: string;
      };
      readonly events?: Readonly<Record<string, string>>;
    };

export type ComponentRegistry = Readonly<Record<string, ComponentOverride>>;

export interface RenderOptions {
  readonly registry?: ComponentRegistry;
  /** For which props are children and which are actions. The basic catalog by default. */
  readonly catalog?: SduiCatalog;
  readonly evaluator: Evaluator;
  readonly urlPolicy?: UrlPolicy;
  /** Sends a renderer-to-agent message (an action). */
  readonly dispatch: (message: A2uiRendererMessage) => void;
  /** Writes a value into the data model, by absolute pointer, and redraws. */
  readonly write: (pointer: string, value: unknown) => void;
  /** Reports a problem with the surface — `VALIDATION_FAILED` for an unknown component. */
  readonly report: (error: {
    readonly code: string;
    readonly message: string;
    readonly path?: string;
  }) => void;
  /** The renderer's state between draws, and how to ask for a redraw after changing it. */
  readonly local: Map<string, unknown>;
  readonly redraw: () => void;
  readonly now?: () => Date;
}

const MAX_DEPTH = 64;
/**
 * Components drawn per draw, template items, tabs and options counted — across every surface
 * that shares the draw's budget. A2UI lets a component be shared and templates nest, so a few
 * components can describe millions of drawings; past this the rest is a placeholder and the agent
 * is told. Text, function calls and regex steps are bounded by the same budget (`DRAW_LIMITS`).
 */
export const MAX_DRAWS = DRAW_LIMITS.draws;

/** Attribute names a host element is never given from content. */
const DENIED_ATTRIBUTES = new Set([
  'class',
  'style',
  'slot',
  'is',
  'id',
  'name',
  'form',
  'tabindex',
  'autofocus',
  'contenteditable',
  'inert',
  'hidden',
  'accesskey',
  'popover',
  'popovertarget',
  'popovertargetaction',
  'draggable',
  'spellcheck',
  'part',
  'exportparts',
  'nonce',
  'href',
  'src',
  'srcset',
  'action',
  'formaction',
  'poster',
  'xmlns',
]);
const DENIED_PREFIXES = [
  'on',
  'data-a2ui',
  'x-',
  'hx-',
  'v-',
  'ng-',
  'data-bind',
  'data-hx-',
  'data-x-',
  'data-v-',
  'aria-',
];

/** The view for one surface, with its container. */
export function renderSurface(
  surface: A2uiSurfaceState,
  options: RenderOptions,
): ViewElement {
  const catalog = options.catalog ?? a2uiBasicCatalog;
  const registry = options.registry ?? {};
  // A renderer drawing several surfaces shares one budget among them; drawing alone, renew it.
  options.evaluator.beginDraw();
  const budget = (): DrawBudget => options.evaluator.budget();
  const truncated = (path: string): void => {
    if (budget().reported.has('draws')) return;
    budget().reported.add('draws');
    options.report({
      code: 'VALIDATION_FAILED',
      message: `the surface draws more than ${budget().drawLimit} components; the rest are not drawn`,
      path,
    });
  };
  const draw = (
    id: unknown,
    scope: EvaluationScope,
    key: string,
    parent: string,
    ancestry: readonly string[],
  ): View | null => {
    if (typeof id !== 'string') return null;
    // Out of components, or out of work or time (the evaluator has said which): the rest is a
    // placeholder, and costs nothing to make.
    const spent = budget().spent;
    if (spent || ++budget().draws > budget().drawLimit) {
      if (!spent) truncated(`/components/${id}`);
      return h('div', {
        class: 'a2ui-placeholder',
        'data-a2ui-truncated': '',
        key,
      });
    }
    if (ancestry.length > MAX_DEPTH || ancestry.includes(id)) {
      options.report({
        code: 'VALIDATION_FAILED',
        message: `"${id}" contains itself, or nests too deeply to draw`,
        path: `/components/${id}`,
      });
      return null;
    }
    const component = surface.components.get(id);
    if (!component)
      return h('div', {
        class: 'a2ui-placeholder',
        'aria-busy': 'true',
        'data-a2ui-pending': id,
        key,
      });
    const context = contextFor(component, scope, key, `${parent}/${key}`, [
      ...ancestry,
      id,
    ]);
    const override = Object.prototype.hasOwnProperty.call(
      registry,
      component.component,
    )
      ? registry[component.component]
      : undefined;
    let view: View;
    if (override !== undefined)
      view =
        typeof override === 'function'
          ? override(context)
          : hostElement(override, context);
    else {
      const basic = Object.prototype.hasOwnProperty.call(
        BASIC_COMPONENTS,
        component.component,
      )
        ? BASIC_COMPONENTS[component.component]
        : undefined;
      if (!basic) {
        options.report({
          code: 'VALIDATION_FAILED',
          message: `this renderer has no "${component.component}" component`,
          path: `/components/${id}/component`,
        });
        return h('div', {
          class: 'a2ui-placeholder',
          'data-a2ui-unknown': component.component,
          key,
        });
      }
      view = basic(context);
    }
    return decorate(view, component, context);
  };

  const decorate = (
    view: View,
    component: A2uiComponent,
    context: RenderContext & { readonly siblingKey: string },
  ): ViewElement => {
    const element: ViewElement =
      typeof view === 'string' ? h('span', {}, view) : view;
    const accessibility = isRecord(component['@accessibility'])
      ? component['@accessibility']
      : {};
    const weight = component['weight'];
    return {
      ...element,
      key: context.siblingKey,
      attrs: {
        ...element.attrs,
        'data-a2ui-id': component.id,
        ...(accessibility['label'] !== undefined
          ? {
              'aria-label': options.evaluator.text(
                accessibility['label'],
                context.scope,
              ),
            }
          : {}),
        ...(accessibility['description'] !== undefined
          ? {
              'aria-description': options.evaluator.text(
                accessibility['description'],
                context.scope,
              ),
            }
          : {}),
        ...(typeof accessibility['live'] === 'string' &&
        ['off', 'polite', 'assertive'].includes(accessibility['live'])
          ? { 'aria-live': accessibility['live'] }
          : {}),
        ...(typeof weight === 'number' &&
        Number.isFinite(weight) &&
        weight >= 0 &&
        weight <= 1_000
          ? { style: `flex-grow: ${Number(weight.toFixed(3))}` }
          : {}),
      },
    };
  };

  const hostElement = (
    override: Exclude<ComponentOverride, ComponentRenderer>,
    context: RenderContext,
  ): ViewElement => {
    // A fragment is a realm of its own: a draw boots only so many.
    if (
      'fragment' in override &&
      ++budget().fragments > DRAW_LIMITS.fragments
    ) {
      if (!budget().reported.has('fragments')) {
        budget().reported.add('fragments');
        options.report({
          code: 'VALIDATION_FAILED',
          message: `the surface draws more than ${DRAW_LIMITS.fragments} fragments; the rest are not drawn`,
          path: `/components/${context.id}`,
        });
      }
      return h('div', { class: 'a2ui-placeholder', 'data-a2ui-truncated': '' });
    }
    const props: Record<string, unknown> = {};
    const children: View[] = [];
    const slotProps = new Set<string>();
    for (const plan of childProps(catalog, context.component.component)) {
      slotProps.add(plan);
      for (const child of context.children(plan).length
        ? context.children(plan)
        : [context.child(plan)])
        if (child)
          children.push(
            typeof child === 'string'
              ? child
              : { ...child, attrs: { ...child.attrs, slot: plan } },
          );
    }
    // Each prop is looked at on every drawing: paid for, however many a component has.
    const keys = propKeys(context.component);
    let affordable = options.evaluator.spend(keys.length);
    if (affordable && keys.length > MAX_HOST_PROPS) {
      affordable = false;
      if (!budget().reported.has('host-prop-count')) {
        budget().reported.add('host-prop-count');
        options.report({
          code: 'VALIDATION_FAILED',
          message: `"${context.component.component}" has more than ${MAX_HOST_PROPS} props to hand to the host's component`,
          path: `/components/${context.id}`,
        });
      }
    }
    const actions = actionProps(catalog, context.component.component);
    for (const key of affordable ? keys : []) {
      // Out of budget, the rest is not looked at: each would fail, and failing costs too.
      if (budget().spent) break;
      if (
        key === 'id' ||
        key === 'component' ||
        key.startsWith('@') ||
        slotProps.has(key)
      )
        continue;
      if (actions.includes(key)) continue;
      const value = context.value(key);
      // A host element is handed its props as a copy, on every drawing: their size is paid for as
      // work and as text, and a prop past the limit is not handed over at all.
      const weight = options.evaluator.measure(value);
      const size = weight === null ? null : weight.chars + 2 * weight.values;
      if (
        size === null ||
        size > MAX_HOST_PROP ||
        // what a host element is handed it may show: priced as text, against the text limit
        (budget().chars += layoutCost(
          typeof value === 'string' ? value : (JSON.stringify(value) ?? ''),
        )) > budget().textLimit
      ) {
        if (!budget().reported.has('host-props')) {
          budget().reported.add('host-props');
          options.report({
            code: 'VALIDATION_FAILED',
            message: `a prop of "${context.component.component}" is too large to hand to the host's component`,
            path: `/components/${context.id}/${key}`,
          });
        }
        continue;
      }
      props[key] = value;
    }
    const on: Record<string, (event: Event) => void> = {};
    if ('fragment' in override) {
      on['braid:event'] = (event: Event) => {
        const detail = (
          event as CustomEvent<{ type?: string; detail?: unknown }>
        ).detail;
        const prop =
          detail && typeof detail.type === 'string'
            ? override.events?.[detail.type]
            : undefined;
        if (prop) runAction(context, prop, detail?.detail);
      };
      return {
        tag: 'fragment-slot',
        attrs: {
          name: override.fragment.name,
          adapter: override.fragment.adapter ?? 'contract',
          entry: override.fragment.entry,
        },
        props: { props },
        on,
      };
    }
    for (const [type, prop] of Object.entries(override.events ?? {}))
      on[type] = () => runAction(context, prop);
    // Attributes only for the scalar props the catalog declares, under names content cannot
    // choose: an attribute can be a framework's directive (x-init, hx-on) or move the element
    // (slot, popover). Everything is in the `a2ui` property regardless.
    const declared = declaredProps(catalog, context.component.component);
    const attrs: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(props)) {
      if (!declared.has(key)) continue;
      if (
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      )
        continue;
      const name = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      if (
        !/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
        DENIED_ATTRIBUTES.has(name) ||
        DENIED_PREFIXES.some((prefix) => name.startsWith(prefix))
      )
        continue;
      attrs[name] = value;
    }
    return {
      tag: override.element,
      attrs,
      props: { a2ui: props },
      on,
      children,
    };
  };

  const runAction = (
    context: RenderContext,
    prop: string,
    detail?: unknown,
  ): void => {
    const action = context.raw(prop);
    if (!isRecord(action)) return;
    if (!context.checks().valid) return;
    if (isRecord(action['event'])) {
      const event = action['event'];
      const resolved = options.evaluator.value(
        event['context'] ?? {},
        context.scope,
      );
      // A copy: what was read from the data model goes on changing with it, and a listener may
      // keep the message. And a bounded one: an action is a request, not a way to make a click
      // copy and send everything a surface holds, as many times as it names it.
      let contextValue: Record<string, unknown> = {};
      if (isRecord(resolved)) {
        const weight = options.evaluator.measure(resolved);
        const json =
          weight !== null && weight.chars <= MAX_ACTION_CONTEXT
            ? JSON.stringify(resolved)
            : undefined;
        if (json !== undefined && json.length <= 6 * MAX_ACTION_CONTEXT)
          contextValue = JSON.parse(json) as Record<string, unknown>;
        else
          options.report({
            code: 'VALIDATION_FAILED',
            message: `the action's context is larger than ${MAX_ACTION_CONTEXT} characters; it is sent empty`,
            path: `/components/${context.id}`,
          });
      }
      const userMessage =
        event['userMessage'] !== undefined
          ? options.evaluator.text(event['userMessage'], context.scope)
          : undefined;
      options.dispatch({
        version: '1.0',
        action: {
          name: String(event['name']),
          surfaceId: surface.id,
          sourceComponentId: context.id,
          timestamp: (options.now?.() ?? new Date()).toISOString(),
          context:
            detail === undefined ? contextValue : { ...contextValue, detail },
          ...(userMessage ? { userMessage } : {}),
        },
      });
    } else if (isRecord(action['functionCall']))
      options.evaluator.activate(action['functionCall'], context.scope);
  };

  const contextFor = (
    component: A2uiComponent,
    scope: EvaluationScope,
    siblingKey: string,
    key: string,
    ancestry: readonly string[],
  ): RenderContext & { readonly siblingKey: string } => {
    const raw = (name: string): unknown =>
      Object.prototype.hasOwnProperty.call(component, name)
        ? component[name]
        : undefined;
    const context: RenderContext & { readonly siblingKey: string } = {
      surfaceId: surface.id,
      id: component.id,
      key,
      siblingKey,
      component,
      scope,
      raw,
      value: (name) => options.evaluator.value(raw(name), scope),
      text: (name) => options.evaluator.text(raw(name), scope),
      boolean: (name) => options.evaluator.boolean(raw(name), scope),
      textOf: (value) => options.evaluator.text(value, scope),
      child: (name) => draw(raw(name), scope, String(raw(name)), key, ancestry),
      childById: (id) => draw(id, scope, String(id), key, ancestry),
      children(name) {
        const value = raw(name);
        if (Array.isArray(value)) {
          // No more than could be drawn: a list naming one component 100,000 times is 100,000
          // placeholders otherwise.
          // A component named twice in one list is two drawings, kept apart by occurrence:
          // otherwise only one of them is matched to what was drawn last time.
          const seen = new Map<string, number>();
          return value
            .slice(0, MAX_DRAWS + 1)
            .map((id) => {
              const name = String(id);
              const n = seen.get(name) ?? 0;
              seen.set(name, n + 1);
              return draw(
                id,
                scope,
                n === 0 ? name : `${name}#${n}`,
                key,
                ancestry,
              );
            })
            .filter((v): v is View => v !== null);
        }
        if (
          isRecord(value) &&
          typeof value['path'] === 'string' &&
          typeof value['componentId'] === 'string'
        ) {
          const items = options.evaluator.value(
            { '@path': value['path'] },
            scope,
          );
          if (!Array.isArray(items)) return [];
          const base = resolvePointer(value['path'], scope.base);
          return items
            .slice(0, 1_000)
            .map((_, index) =>
              draw(
                value['componentId'],
                { base: [...base, String(index)], index },
                `${value['componentId']}#${index}`,
                key,
                ancestry,
              ),
            )
            .filter((v): v is View => v !== null);
        }
        return [];
      },
      bind(name) {
        const value = raw(name);
        if (isRecord(value) && typeof value['@path'] === 'string') {
          const pointer = formatPointer(
            resolvePointer(value['@path'], scope.base),
          );
          return {
            value: options.evaluator.value(value, scope),
            write: (next) => options.write(pointer, next),
          };
        }
        const slot = `${key}:${name}`;
        const kept = options.local.has(slot)
          ? options.local.get(slot)
          : options.evaluator.value(value, scope);
        return {
          value: kept,
          write: (next) => {
            options.local.set(slot, next);
            options.redraw();
          },
        };
      },
      checks: () => options.evaluator.checks(raw('@checks'), scope),
      action: (name) =>
        isRecord(raw(name)) ? () => runAction(context, name) : null,
      url: (name, use) =>
        checkUrl(
          options.evaluator.value(raw(name), scope),
          use,
          options.urlPolicy,
        ),
      markdown: (source) => {
        // The elements a text's markup makes are drawn like components: past what the draw has
        // left, the text is drawn plain.
        const result = markdown(source);
        const made = elementsIn(result.views);
        return made === 0 || context.allow(made) === made
          ? result
          : { inline: true, views: [source] };
      },
      allow(count) {
        const room = Math.max(0, budget().drawLimit - budget().draws);
        const granted = Math.min(count, room);
        budget().draws += granted;
        if (granted < count) truncated(`/components/${component.id}`);
        return granted;
      },
      local<T>(name: string, initial: T): [T, (value: T) => void] {
        const slot = `${key}::${name}`;
        const current = (
          options.local.has(slot) ? options.local.get(slot) : initial
        ) as T;
        return [
          current,
          (value: T) => {
            options.local.set(slot, value);
            options.redraw();
          },
        ];
      },
    };
    return context;
  };

  const root = draw('root', ROOT_SCOPE, 'root', '', []);
  return h(
    'div',
    {
      class: 'a2ui-surface',
      'data-a2ui-surface': surface.id,
      key: `surface:${surface.id}`,
    },
    root ??
      h('div', {
        class: 'a2ui-placeholder',
        'aria-busy': 'true',
        'data-a2ui-pending': 'root',
      }),
  );
}

function childProps(catalog: SduiCatalog, type: string): string[] {
  const definition = Object.prototype.hasOwnProperty.call(
    catalog.components,
    type,
  )
    ? catalog.components[type]
    : undefined;
  if (!definition) return ['child', 'children'];
  return Object.entries(definition.slots ?? {}).map(
    ([slot, spec]) => spec.a2ui?.list ?? slot,
  );
}

/** Characters of one prop a host element may be handed. */
const MAX_HOST_PROP = 16_000;
/** Characters an action's context may carry. */
const MAX_ACTION_CONTEXT = 100_000;
/** Props a host element may be handed: a component of more hands over none. */
const MAX_HOST_PROPS = 256;

/** A component's prop names, listed once per component rather than once per drawing. */
const propKeysOf = new WeakMap<object, readonly string[]>();
function propKeys(component: object): readonly string[] {
  let keys = propKeysOf.get(component);
  if (!keys) propKeysOf.set(component, (keys = Object.keys(component)));
  return keys;
}

/** The props a component's newest schema declares. */
function declaredProps(
  catalog: SduiCatalog,
  type: string,
): ReadonlySet<string> {
  const definition = Object.prototype.hasOwnProperty.call(
    catalog.components,
    type,
  )
    ? catalog.components[type]
    : undefined;
  const schema =
    definition?.contract.schemas?.[String(definition.contract.current)];
  const properties =
    isRecord(schema) && isRecord(schema['properties'])
      ? schema['properties']
      : {};
  return new Set(Object.keys(properties));
}

function actionProps(catalog: SduiCatalog, type: string): readonly string[] {
  const definition = Object.prototype.hasOwnProperty.call(
    catalog.components,
    type,
  )
    ? catalog.components[type]
    : undefined;
  return definition ? (definition.a2ui?.actions ?? []) : ['action'];
}

/**
 * Draws one surface, and if drawing it fails — a host component that throws, a bug — reports it
 * and draws an empty container instead: one surface must not take the others on the page down.
 */
export function drawSafely(
  surfaceId: string,
  report: (error: { readonly code: string; readonly message: string }) => void,
  draw: () => ViewElement,
): ViewElement {
  try {
    return draw();
  } catch (error) {
    report({
      code: 'RENDER_ERROR',
      message: `the surface could not be drawn: ${error instanceof Error ? error.message : String(error)}`,
    });
    return h('div', {
      class: 'a2ui-surface',
      'data-a2ui-surface': surfaceId,
      'data-a2ui-failed': '',
      key: `surface:${surfaceId}`,
    });
  }
}

/** Elements in some views, nested ones included. */
function elementsIn(views: readonly View[]): number {
  let count = 0;
  const stack = [...views];
  while (stack.length > 0) {
    const view = stack.pop();
    if (view === undefined || typeof view === 'string') continue;
    count++;
    for (const child of view.children ?? []) stack.push(child);
  }
  return count;
}
