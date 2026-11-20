/**
 * `@braidlabs/sdui/a2ui` — A2UI v1.0 as a first-class wire format for server-driven UI.
 *
 * A2UI is how agents describe UI to renderers. This entry reads and writes it, and joins it to
 * the SDUI model: an A2UI surface is a screen, a renderer's catalog is a client manifest, and so
 * an agent — or a CMS author — writes once, at the newest version of each component, and every
 * renderer receives what it was built to draw. Pure, like the rest of the package.
 */
export * from './a2ui/messages.js';
export * from './a2ui/surfaces.js';
export * from './a2ui/basic.js';
export * from './a2ui/codec.js';
export * from './a2ui/capabilities.js';
export * from './a2ui/projector.js';
export * from './a2ui/prerender.js';
