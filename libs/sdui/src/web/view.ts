import { checkUrl } from './evaluate.js';

/**
 * A view: the tree the renderer's components build, and the one thing both backends draw — as DOM
 * in a browser (`dom.ts`), as HTML on a server (`toHtml`, for prerendering).
 *
 * Tags and attributes are checked here, once, for both: content decides text and attribute
 * values, never which element is made or which attribute is set. So no tag outside the list
 * below, no event-handler attribute, a URL attribute only when it passed the URL policy, and
 * text only ever as text — there is no path from an agent's string to markup.
 */

export interface ViewElement {
  readonly tag: string;
  readonly attrs?: Readonly<
    Record<string, string | number | boolean | undefined>
  >;
  /** DOM properties, set in a browser and not written to HTML: `value`, `checked`, `props`. */
  readonly props?: Readonly<Record<string, unknown>>;
  /** Listeners, in a browser only. */
  readonly on?: Readonly<Record<string, (event: Event) => void>>;
  readonly children?: readonly View[];
  /**
   * Matches this element to the one drawn last time, so an update patches it rather than
   * replacing it: an input keeps its focus and caret. Written as `data-a2ui-key`, which is how a
   * renderer adopts prerendered HTML.
   */
  readonly key?: string;
}

export type View = ViewElement | string;

/** Builds a {@link ViewElement}; falsy children are dropped. */
export function h(
  tag: string,
  attrs: ViewElement['attrs'] & { key?: string } = {},
  ...children: readonly (
    | View
    | null
    | undefined
    | false
    | readonly (View | null | undefined | false)[]
  )[]
): ViewElement {
  const { key, ...rest } = attrs as Record<
    string,
    string | number | boolean | undefined
  >;
  const flat = children
    .flat()
    .filter(
      (child): child is View =>
        child !== null &&
        child !== undefined &&
        child !== false &&
        child !== '',
    );
  return {
    tag,
    attrs: rest,
    ...(flat.length > 0 ? { children: flat } : {}),
    ...(typeof key === 'string' ? { key } : {}),
  };
}

/** Every built-in element the renderer makes. */
export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'div',
  'span',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'code',
  'a',
  'ul',
  'ol',
  'li',
  'br',
  'hr',
  'img',
  'video',
  'audio',
  'button',
  'label',
  'input',
  'textarea',
  'select',
  'option',
  'dialog',
  'svg',
  'path',
  'section',
  'fieldset',
  'legend',
]);
/** Tags never made, whatever a host registers. */
const FORBIDDEN_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
  'template',
  'noscript',
]);
const VOID = new Set(['br', 'hr', 'img', 'input']);
const URL_ATTRS = new Set([
  'href',
  'src',
  'poster',
  'action',
  'formaction',
  'xlink:href',
  'srcset',
]);
/** A custom element's name: a host's own component, or Braid's `fragment-slot`. */
export const CUSTOM_ELEMENT = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

export class ViewError extends Error {
  override readonly name = 'ViewError';
}

/** Throws {@link ViewError} for a tag the renderer must not make. */
export function assertTag(tag: string): void {
  if (
    FORBIDDEN_TAGS.has(tag) ||
    !(ALLOWED_TAGS.has(tag) || CUSTOM_ELEMENT.test(tag))
  )
    throw new ViewError(`the renderer does not make <${tag}> elements`);
}

/**
 * Whether an attribute may be set. Never an event handler; `style` only as `flex-grow: <number>`,
 * which is all the layout needs; and a URL attribute only with a URL the default policy allows.
 * Components check URLs against the page's own policy before they use one — this is the backstop
 * that makes a `javascript:` URL unwritable even by a component that forgot.
 */
export function attributeAllowed(name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (!/^[a-z][a-z0-9:-]*$/.test(lower) || lower.startsWith('on')) return false;
  if (
    lower === 'srcdoc' ||
    lower === 'srcset' ||
    lower === 'formaction' ||
    lower === 'action'
  )
    return false;
  if (URL_ATTRS.has(lower))
    return checkUrl(
      value,
      lower === 'href' || lower === 'xlink:href' ? 'link' : 'image',
    ).ok;
  if (lower === 'style') return /^flex-grow: \d+(\.\d+)?$/.test(value);
  return true;
}

const escapeText = (text: string): string =>
  text.replace(/[&<>]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;',
  );
const escapeAttr = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );

/** Attributes as they are written, after the checks. `true` is a present boolean attribute. */
export function attributesOf(view: ViewElement): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, raw] of Object.entries(view.attrs ?? {})) {
    if (raw === undefined || raw === false) continue;
    const value = raw === true ? '' : String(raw);
    if (attributeAllowed(name, value)) out.push([name, value]);
  }
  if (view.key !== undefined) out.push(['data-a2ui-key', view.key]);
  return out;
}

/** A view as HTML: what prerendering writes, and what a browser that runs no script shows. */
export function toHtml(view: View | readonly View[]): string {
  if (Array.isArray(view)) return view.map((v) => toHtml(v)).join('');
  if (typeof view === 'string') return escapeText(view);
  const element = view as ViewElement;
  assertTag(element.tag);
  const attrs = attributesOf(element)
    .map(([name, value]) =>
      value === '' ? ` ${name}` : ` ${name}="${escapeAttr(value)}"`,
    )
    .join('');
  // A textarea's content is its value; a select's selected option is an attribute.
  const value = element.props?.['value'];
  if (element.tag === 'textarea')
    return `<textarea${attrs}>${escapeText(typeof value === 'string' ? value : '')}</textarea>`;
  if (element.tag === 'input') {
    const extra =
      typeof value === 'string' || typeof value === 'number'
        ? ` value="${escapeAttr(String(value))}"`
        : '';
    const checked = element.props?.['checked'] === true ? ' checked' : '';
    return `<input${attrs}${extra}${checked}>`;
  }
  if (VOID.has(element.tag)) return `<${element.tag}${attrs}>`;
  return `<${element.tag}${attrs}>${toHtml(element.children ?? [])}</${element.tag}>`;
}
