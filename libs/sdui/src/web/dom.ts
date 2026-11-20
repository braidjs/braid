import {
  type View,
  type ViewElement,
  assertTag,
  attributesOf,
} from './view.js';

/**
 * Drawing views into the DOM, by patching what is there.
 *
 * Each element is matched to the one drawn last time by its key (or its place among unkeyed
 * siblings) and updated in place, so an update never replaces an input under someone's cursor:
 * it keeps its focus, its caret and its selection. Prerendered HTML carries the same keys as
 * `data-a2ui-key`, so the first patch over it adopts the elements the server wrote instead of
 * building new ones.
 *
 * Text is set as text and attributes through the view's checks; there is no `innerHTML` here.
 */

interface Managed {
  /** The attributes this patcher set, so it removes only its own. */
  attrs: Set<string>;
  /** The listener for each event type, behind one stable dispatcher per type. */
  handlers: Map<string, (event: Event) => void>;
  /** JSON of the last structured property set, so it is set only when it changes. */
  props: Map<string, string>;
}

const managed = new WeakMap<Element, Managed>();

function stateOf(element: Element): Managed {
  let state = managed.get(element);
  if (!state) {
    // An element this patcher did not make — prerendered — is adopted with what it already has.
    state = {
      attrs: new Set(element.getAttributeNames()),
      handlers: new Map(),
      props: new Map(),
    };
    managed.set(element, state);
  }
  return state;
}

const SVG = 'http://www.w3.org/2000/svg';

function create(view: View, document: Document, svg: boolean): Node {
  if (typeof view === 'string') return document.createTextNode(view);
  assertTag(view.tag);
  const inSvg = svg || view.tag === 'svg';
  const element = inSvg
    ? document.createElementNS(SVG, view.tag)
    : document.createElement(view.tag);
  managed.set(element, {
    attrs: new Set(),
    handlers: new Map(),
    props: new Map(),
  });
  update(element, view, inSvg);
  return element;
}

/** Properties that mirror what a person does to a control; set only when they differ. */
const LIVE = new Set(['value', 'checked']);

function update(element: Element, view: ViewElement, svg: boolean): void {
  const state = stateOf(element);
  const wanted = attributesOf(view);
  const names = new Set(wanted.map(([name]) => name));
  for (const name of state.attrs)
    if (!names.has(name)) element.removeAttribute(name);
  for (const [name, value] of wanted)
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  state.attrs = names;

  for (const [name, value] of Object.entries(view.props ?? {})) {
    const target = element as unknown as Record<string, unknown>;
    if (LIVE.has(name)) {
      if (name === 'value') {
        const next = value === null || value === undefined ? '' : String(value);
        if (target['value'] === next) continue;
        const control = element as HTMLInputElement;
        const focused = element.ownerDocument.activeElement === element;
        let start: number | null = null;
        let end: number | null = null;
        try {
          start = control.selectionStart;
          end = control.selectionEnd;
        } catch {
          // a control type with no selection
        }
        control.value = next;
        if (focused && start !== null && end !== null) {
          try {
            control.setSelectionRange(
              Math.min(start, next.length),
              Math.min(end, next.length),
            );
          } catch {
            // as above
          }
        }
      } else if (target[name] !== value) target[name] = value;
      continue;
    }
    // A structured property — a fragment's props, a host element's a2ui — goes in a fresh copy,
    // and only when it changed: a fragment hears every assignment as new props.
    const json = JSON.stringify(value) ?? 'undefined';
    if (state.props.get(name) === json) continue;
    state.props.set(name, json);
    target[name] = value === undefined ? undefined : JSON.parse(json);
  }

  const types = new Set(Object.keys(view.on ?? {}));
  for (const [type, handler] of Object.entries(view.on ?? {})) {
    if (!state.handlers.has(type))
      element.addEventListener(type, (event) => {
        state.handlers.get(type)?.(event);
      });
    state.handlers.set(type, handler);
  }
  for (const type of [...state.handlers.keys()])
    if (!types.has(type)) state.handlers.delete(type);

  // A textarea's text is its value; its children are not ours to draw.
  if (view.tag === 'textarea') return;
  patchChildren(element, view.children ?? [], svg || view.tag === 'svg');
}

function keyOf(node: Node): string | null {
  return node.nodeType === 1
    ? (node as Element).getAttribute('data-a2ui-key')
    : null;
}

/**
 * Makes `parent`'s children the given views. Nodes the patcher did not draw and that carry no key
 * are matched by position among the unkeyed, as prerendered text and elements are.
 */
export function patchChildren(
  parent: Element,
  views: readonly View[],
  svg = false,
): void {
  const document = parent.ownerDocument;
  const keyed = new Map<string, Node>();
  const unkeyed: Node[] = [];
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === 8) {
      node.remove(); // comments carry nothing
      continue;
    }
    const key = keyOf(node);
    if (key !== null) keyed.set(key, node);
    else unkeyed.push(node);
  }
  let position = 0;
  const used = new Set<Node>();
  let cursor: ChildNode | null = parent.firstChild;
  for (const view of views) {
    let node: Node | undefined;
    if (typeof view === 'string') {
      const candidate = unkeyed[position];
      if (candidate && candidate.nodeType === 3 && !used.has(candidate))
        node = candidate;
      if (node) {
        if (node.nodeValue !== view) node.nodeValue = view;
        position++;
      }
    } else if (view.key !== undefined) {
      const candidate = keyed.get(view.key);
      if (
        candidate &&
        (candidate as Element).localName === view.tag &&
        !used.has(candidate)
      )
        node = candidate;
    } else {
      const candidate = unkeyed[position];
      if (
        candidate &&
        candidate.nodeType === 1 &&
        (candidate as Element).localName === view.tag &&
        !used.has(candidate)
      ) {
        node = candidate;
        position++;
      } else if (candidate && candidate.nodeType === 1) position++;
    }
    if (node && typeof view !== 'string')
      update(node as Element, view, svg || view.tag === 'svg');
    if (!node) node = create(view, document, svg);
    used.add(node);
    if (node !== cursor) parent.insertBefore(node, cursor);
    else cursor = cursor.nextSibling;
  }
  // What is left was not drawn this time.
  for (const node of [...parent.childNodes]) if (!used.has(node)) node.remove();
}
