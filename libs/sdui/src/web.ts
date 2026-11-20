/**
 * `@braidlabs/sdui/web` — an A2UI renderer that draws into the host's own page.
 *
 * `<a2ui-surface>` renders A2UI surfaces in light DOM, so they are laid out, styled and read as
 * part of the host's UI. Component types can be the host's own components — a custom element, or
 * a Braid fragment from another team — through the registry. `renderA2uiHtml` draws the same
 * surfaces as HTML on a server, which the element takes over in the browser.
 *
 * Importing this entry defines nothing; `defineA2uiSurface()` does, in a browser.
 */
export * from './web/evaluate.js';
export {
  compileA2uiRegex,
  a2uiRegexMatches,
  RegexDialectError,
  REGEX_LIMITS,
} from './web/regex.js';
export * from './web/view.js';
export { markdown } from './web/markdown.js';
export { BASIC_COMPONENTS, A2UI_DEFAULT_CSS } from './web/components.js';
export * from './web/render.js';
export { patchChildren } from './web/dom.js';
export * from './web/html.js';
export * from './web/element.js';
