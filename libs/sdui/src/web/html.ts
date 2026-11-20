import type { SduiCatalog } from '../lib/catalog.js';
import {
  A2uiError,
  type A2uiMessage,
  parseA2uiMessage,
} from '../a2ui/messages.js';
import { A2uiSurfaces } from '../a2ui/surfaces.js';
import {
  type HostFunction,
  type ReportedError,
  type UrlPolicy,
  createEvaluator,
} from './evaluate.js';
import { type ComponentRegistry, drawSafely, renderSurface } from './render.js';
import { toHtml } from './view.js';

/**
 * A2UI as HTML, on a server — what prerendering writes.
 *
 * The page shows the surfaces before any script runs, and with none at all. The messages that
 * built them travel inside, as `<script type="application/a2ui+json">`, so the renderer in the
 * browser rebuilds the same state, draws the same views, and patches over this markup rather
 * than replacing it.
 */

export interface RenderHtmlOptions {
  readonly registry?: ComponentRegistry;
  readonly catalog?: SduiCatalog;
  readonly urlPolicy?: UrlPolicy;
  readonly functions?: Readonly<Record<string, HostFunction>>;
  /** The page's locale and time zone; the browser's renderer must be given the same. */
  readonly locale?: string;
  readonly timeZone?: string;
  /** The renderer's element name. */
  readonly tag?: string;
  /** Written onto the element: what the browser's renderer declares it supports. */
  readonly catalogIds?: readonly string[];
}

export interface RenderedHtml {
  readonly html: string;
  /** Problems found while drawing — what the browser's renderer would report to the agent. */
  readonly errors: readonly ReportedError[];
}

const escapeAttr = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** JSON safe inside a `<script>`: nothing in it can close the element or start a comment. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function renderA2uiHtml(
  messages: readonly unknown[],
  options: RenderHtmlOptions = {},
): RenderedHtml {
  const surfaces = new A2uiSurfaces();
  const errors: ReportedError[] = [];
  const accepted: A2uiMessage[] = [];
  for (const raw of messages) {
    try {
      const message = parseA2uiMessage(raw);
      surfaces.apply(message);
      accepted.push(message);
    } catch (error) {
      if (!(error instanceof A2uiError)) throw error;
      errors.push({ code: error.code, message: error.message });
    }
  }
  const tag = options.tag ?? 'a2ui-surface';
  const views = surfaces.ids().map((id) => {
    const surface = surfaces.get(id)!;
    const evaluator = createEvaluator({
      model: () => surface.dataModel,
      locale: options.locale,
      timeZone: options.timeZone,
      urlPolicy: options.urlPolicy,
      functions: options.functions,
      report: (error) => errors.push(error),
    });
    return drawSafely(
      id,
      (error) => errors.push(error),
      () =>
        renderSurface(surface, {
          registry: options.registry,
          catalog: options.catalog,
          evaluator,
          urlPolicy: options.urlPolicy,
          dispatch: () => undefined,
          write: () => undefined,
          report: (error) => errors.push(error),
          local: new Map(),
          redraw: () => undefined,
        }),
    );
  });
  const attrs = [
    'data-prerendered',
    ...(options.catalogIds
      ? [`catalog-ids="${escapeAttr(options.catalogIds.join(' '))}"`]
      : []),
    ...(options.locale ? [`locale="${escapeAttr(options.locale)}"`] : []),
    ...(options.timeZone
      ? [`time-zone="${escapeAttr(options.timeZone)}"`]
      : []),
  ].join(' ');
  const html =
    `<${tag} ${attrs}>` +
    toHtml(views) +
    `<script type="application/a2ui+json">${scriptJson(accepted)}</script>` +
    `</${tag}>`;
  return { html, errors };
}
