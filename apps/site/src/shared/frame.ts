import css from './fragment.css';

/**
 * What the host and its fragments agree on. Kept free of `@braidlabs/core` so the Node prerender can
 * import it: the runtime defines DOM classes at module load, which Node does not have.
 */

/** The context key the host publishes "show the seams" under. Every section subscribes to it. */
export const SEAMS_KEY = 'site:seams';

/** The host's contract version. Every section requires at least this of whichever host mounts it. */
export const HOST_CONTRACT_VERSION = '1.0.0';

/**
 * A section's whole shadow-root content: its own styles, then its markup, seams showing.
 *
 * The prerender puts exactly this in the page, and the fragment renders exactly this when it mounts,
 * so the swap from the static copy to the live fragment changes nothing on screen.
 */
export function frame(markup: string): string {
  return `<style>${css}</style><div class="frag" data-seams>${markup}</div>`;
}
