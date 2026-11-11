/**
 * The tiles' default look, in a cascade layer of its own: any unlayered rule of the host's wins
 * over it, whatever its specificity, so a host restyles a tile with plain selectors and no
 * `!important`. System colours only, so it reads in light and dark pages alike.
 */
export const TILES_CSS = `@layer braid-tiles {
.braid-tile-head {
  position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  padding: 4px 6px; background: Canvas; color: CanvasText; font: 13px/1.4 system-ui, sans-serif;
  border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
}
.braid-tile-head button, .braid-tile-head a {
  display: inline-grid; place-items: center; min-width: 28px; height: 28px; padding: 0 6px; border: 1px solid transparent;
  border-radius: 6px; background: none; color: inherit; font: inherit; text-decoration: none; cursor: pointer;
}
.braid-tile-head button:hover, .braid-tile-head a:hover { border-color: color-mix(in srgb, CanvasText 25%, transparent); }
.braid-tile-grip { cursor: grab; touch-action: none; }
.braid-tile-title { font-weight: 600; margin-inline-end: auto; }
.braid-tile-menu {
  position: absolute; top: 100%; left: 4px; z-index: 5; display: grid; gap: 2px; padding: 4px; border-radius: 8px;
  background: Canvas; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
}
.braid-tile-menu[hidden] { display: none; }
.braid-tile-head .braid-tile-menu button { justify-content: start; padding: 0 10px; }

.braid-tile-frame { position: sticky; top: 0; z-index: 3; order: -1; flex: none; align-self: stretch; height: 0; pointer-events: none; }
.braid-tile-edge { position: absolute; pointer-events: auto; touch-action: none; }
.braid-tile-edge[data-edge="right"] { top: 0; right: 0; width: 8px; height: var(--braid-tile-height, 0px); cursor: ew-resize; }
.braid-tile-edge[data-edge="bottom"] { left: 0; right: 0; top: calc(var(--braid-tile-height, 0px) - 8px); height: 8px; cursor: ns-resize; }
.braid-tile-edge[data-edge="corner"] {
  right: 0; top: calc(var(--braid-tile-height, 0px) - 18px); width: 18px; height: 18px; cursor: nwse-resize; opacity: 0.5;
  background: linear-gradient(135deg, transparent 50%, currentColor 50%, currentColor 58%, transparent 58%, transparent 70%, currentColor 70%, currentColor 78%, transparent 78%);
}
.braid-tile-edge[data-edge="right"]:hover, .braid-tile-edge[data-edge="bottom"]:hover { background: color-mix(in srgb, Highlight 45%, transparent); }
.braid-tile-edge[data-edge="corner"]:hover { opacity: 1; }
[data-braid-tiles-single] .braid-tile-frame, [data-braid-tiles-single] .braid-tile-size { display: none; }

.braid-tile-outline {
  position: fixed; z-index: 2147483000; display: grid; place-items: center; box-sizing: border-box; pointer-events: none;
  border: 2px dashed Highlight; border-radius: 8px; background: color-mix(in srgb, Highlight 12%, transparent);
  color: CanvasText; font: 600 14px system-ui, sans-serif;
}
.braid-tiles-moving, .braid-tiles-moving * { cursor: grabbing !important; user-select: none; }
[data-braid-tiles-sizing], [data-braid-tiles-sizing] * { user-select: none; }
[data-braid-tiles-sizing="right"], [data-braid-tiles-sizing="right"] * { cursor: ew-resize !important; }
[data-braid-tiles-sizing="bottom"], [data-braid-tiles-sizing="bottom"] * { cursor: ns-resize !important; }
[data-braid-tiles-sizing="corner"], [data-braid-tiles-sizing="corner"] * { cursor: nwse-resize !important; }
/* an app in a frame would keep the pointer from the page while a tile is resized over it */
[data-braid-tiles-sizing] [data-braid-tiles] > fragment-slot { pointer-events: none; }
.braid-tiles-announcer { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
}`;

const installed = new WeakSet<Document>();

/** Adds {@link TILES_CSS} to `document`, once. */
export function installTilesCss(document: Document): void {
  if (installed.has(document)) return;
  installed.add(document);
  const view = document.defaultView as (Window & typeof globalThis) | null;
  // a constructed sheet, where there is one: no <style> in the page's markup
  if (view && typeof view.CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
    try {
      const sheet = new view.CSSStyleSheet();
      sheet.replaceSync(TILES_CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      return;
    } catch {
      // fall through to a <style>
    }
  }
  const style = document.createElement('style');
  style.dataset.braidTiles = '';
  style.textContent = TILES_CSS;
  document.head.append(style);
}
