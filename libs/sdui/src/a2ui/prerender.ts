import { type SduiCatalog, catalogId } from '../lib/catalog.js';
import type { ConditionContext } from '../lib/conditions.js';
import { sha256Hex } from '../lib/hash.js';
import { type ClientManifest, manifestFingerprint } from '../lib/manifest.js';
import type { Screen } from '../lib/model.js';
import {
  type ProjectionOutcome,
  applyVisibility,
  projectScreen,
} from '../lib/projection.js';
import { a2uiCatalogId } from './capabilities.js';
import { surfaceMessages } from './codec.js';
import { type A2uiMessage, toJsonLines } from './messages.js';

/**
 * Prerendering: every variant of every screen, computed ahead of time.
 *
 * Projection is a pure function of immutable inputs, and the set of manifests a release serves is
 * finite — so what each renderer will receive can be computed once, when a release is published,
 * instead of on every request. Each variant is written as the A2UI stream a renderer of that
 * manifest receives (`.jsonl`) and, when a renderer of HTML is given, as the HTML a browser shows
 * before any script runs (`.html`).
 *
 * Files are content-addressed, so two manifests that see a screen the same way share its files,
 * and publishing an unchanged screen writes nothing. `index.json` says which variant each
 * catalog id gets, and how faithful it is.
 */

export interface PrerenderContext {
  /** Names the variant: `summer-sale`, `fr-CA`. */
  readonly name: string;
  readonly context: ConditionContext;
}

export interface PrerenderInput {
  readonly catalog: SduiCatalog;
  readonly screens: readonly Screen[];
  readonly manifests: readonly ClientManifest[];
  /** Conditions to prerender each variant under. One unnamed variant, with none, by default. */
  readonly contexts?: readonly PrerenderContext[];
  /** Draws a variant's messages as HTML. Without it, only `.jsonl` is written. */
  readonly html?: (messages: readonly A2uiMessage[]) => string;
}

export interface PrerenderVariant {
  /** The id a renderer of this manifest names, which selects the variant. */
  readonly catalogId: string;
  readonly manifest: string;
  readonly context?: string;
  readonly outcome: ProjectionOutcome;
  /** Paths under the output directory. Absent when the screen is blocked for this manifest. */
  readonly jsonl?: string;
  readonly html?: string;
  /** Nodes per outcome: `{ exact: 12, downgraded: 1 }`. */
  readonly nodes: Readonly<Record<string, number>>;
}

export interface PrerenderIndex {
  readonly a2uiPrerender: '1';
  readonly catalog: string;
  readonly screens: Readonly<
    Record<string, { readonly variants: readonly PrerenderVariant[] }>
  >;
}

export interface PrerenderResult {
  readonly index: PrerenderIndex;
  /** Path → content, the index included as `index.json`. */
  readonly files: ReadonlyMap<string, string>;
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

export function prerenderA2ui(input: PrerenderInput): PrerenderResult {
  const { catalog } = input;
  const files = new Map<string, string>();
  const contexts = input.contexts ?? [{ name: '', context: {} }];
  const screens: Record<string, { variants: PrerenderVariant[] }> = {};
  const address = (
    slug: string,
    content: string,
    extension: string,
  ): string => {
    const path = `${slug}/${sha256Hex(content).slice(0, 20)}.${extension}`;
    files.set(path, content);
    return path;
  };
  for (const screen of input.screens) {
    // A slug becomes a directory name.
    if (!SLUG.test(screen.slug))
      throw new TypeError(
        `sdui prerender: "${screen.slug}" is not a slug that can be a directory name`,
      );
    if (Object.prototype.hasOwnProperty.call(screens, screen.slug))
      throw new TypeError(
        `sdui prerender: two screens have the slug "${screen.slug}"`,
      );
    const variants: PrerenderVariant[] = [];
    for (const manifest of input.manifests) {
      const result = projectScreen(screen, catalog, manifest);
      const nodes: Record<string, number> = {};
      for (const entry of result.report)
        nodes[entry.outcome] = (nodes[entry.outcome] ?? 0) + 1;
      for (const { name, context } of contexts) {
        const base = {
          catalogId: a2uiCatalogId(catalog, manifest),
          manifest: manifestFingerprint(manifest),
          ...(name ? { context: name } : {}),
          nodes,
        };
        const visible = applyVisibility(result, context);
        if (result.outcome === 'blocked' || visible.root === null) {
          variants.push({ ...base, outcome: 'blocked' });
          continue;
        }
        const messages = surfaceMessages({
          surfaceId: screen.slug,
          catalogId: base.catalogId,
          root: visible.root,
          dataModel: screen.data,
          catalog,
        });
        variants.push({
          ...base,
          outcome: result.outcome,
          jsonl: address(screen.slug, toJsonLines(messages), 'jsonl'),
          ...(input.html
            ? { html: address(screen.slug, input.html(messages), 'html') }
            : {}),
        });
      }
    }
    screens[screen.slug] = { variants };
  }
  const index: PrerenderIndex = {
    a2uiPrerender: '1',
    catalog: catalogId(catalog),
    screens,
  };
  files.set('index.json', `${JSON.stringify(index, null, 2)}\n`);
  return { index, files };
}

/**
 * The variant to serve a renderer, from the catalog ids it supports, in its order of preference —
 * or `undefined`, when none of them was prerendered (and the request goes to live projection).
 */
export function selectPrerendered(
  index: PrerenderIndex,
  slug: string,
  supportedCatalogIds: readonly string[],
  context?: string,
): PrerenderVariant | undefined {
  const screen = Object.prototype.hasOwnProperty.call(index.screens, slug)
    ? index.screens[slug]
    : undefined;
  if (!screen) return undefined;
  for (const id of supportedCatalogIds) {
    const variant = screen.variants.find(
      (v) => v.catalogId === id && (v.context ?? '') === (context ?? ''),
    );
    if (variant) return variant;
  }
  return undefined;
}
