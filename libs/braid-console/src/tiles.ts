/**
 * @braidlabs/console/tiles — the hands-on half of a workspace: a header on every app in the area
 * (move, size, pop out, close), edges to drag-resize it snapped to the grid, the keyboard for all
 * of it, and popping an app out into a window of its own and back.
 *
 * Framework-free, like `@braidlabs/console/workspace`, and apart from it: a host that arranges
 * its workspace itself loads none of this.
 */
export { arrange } from './tiles/tiles.js';
export type { ArrangeOptions, Tiles } from './tiles/tiles.js';
export { acceptPopOut, HANDOFF_TIMEOUT_MS, RELOAD_GRACE_MS } from './tiles/pop-out.js';
export type { PopOutOptions, AcceptPopOutOptions, AcceptedPopOut } from './tiles/pop-out.js';
export { TILES_CSS } from './tiles/styles.js';
