/**
 * Top-layer overlays: what a fragment portals to its body, lifted out of the host's box.
 *
 * UI libraries render modals, menus and tooltips by appending to `document.body`, which escapes
 * whatever clips the component that opened them. In a compat realm `document.body` is the
 * fragment's own body — inside the slot — so the escape stops at the host's container: an
 * `overflow: hidden` ancestor clips the modal, and a transformed one becomes its fixed-position
 * frame. Other micro-frontend frameworks answer this by letting fragments write into the host's
 * real body, which gives up the isolation the fragment boundary exists for.
 *
 * With `overlays="top-layer"` the slot instead shows each element the fragment appends to its
 * body after mount as a manual popover. The browser renders popovers in the top layer, above and
 * outside every ancestor's clipping, while the element stays exactly where it was in the DOM:
 * inside the fragment's shadow tree, styled by the fragment's stylesheets, its events handled by
 * the fragment's own listeners. Removing the element closes it.
 *
 * Opt-in, because it changes positioning: a lifted element is laid out against the page rather
 * than the slot (see `OVERLAY_STYLES`), which is what a portal intends and a fragment that
 * appends its whole app to the body after mount does not.
 */

/** Marks an element the slot lifted. */
export const OVERLAY_ATTRIBUTE = 'data-braid-overlay';

/**
 * Undoes the browser's popover look (centred, bordered, padded, opaque) so a lifted portal looks as
 * it did in the body, laid out from the page's origin as a body child would be. Zero specificity:
 * any rule of the fragment's own, or its inline style, wins.
 */
export const OVERLAY_STYLES =
  `:where([${OVERLAY_ATTRIBUTE}]) { position: absolute; inset: 0 auto auto 0; margin: 0; padding: 0; border: 0; ` +
  'background: none; color: inherit; overflow: visible; width: auto; height: auto; max-width: none; max-height: none; }';

/** Body children that are not overlays: they render nothing, or they are Braid's own. */
const NOT_OVERLAYS = new Set(['script', 'style', 'link', 'template', 'meta', 'noscript']);

/**
 * Lifts each element appended to the fragment's body from now on. Stops when `signal` aborts (the
 * fragment closes). Does nothing for a fragment with no body (a custom-element fragment) or in a
 * browser without popovers.
 */
export function liftPortals(contentRoot: HTMLElement, signal: AbortSignal): void {
  const body = contentRoot.querySelector('braid-body');
  if (!body || typeof HTMLElement.prototype.showPopover !== 'function') return;

  const lift = (node: Node) => {
    if (!(node instanceof HTMLElement) || node.parentNode !== body) return;
    if (NOT_OVERLAYS.has(node.localName) || node.localName.startsWith('braid-')) return;
    // a popover the fragment declared itself is the fragment's to show
    if (node.hasAttribute('popover')) return;
    node.setAttribute('popover', 'manual');
    node.setAttribute(OVERLAY_ATTRIBUTE, '');
    try {
      node.showPopover();
    } catch {
      // removed again before this ran: nothing to show
    }
  };

  // Observed rather than intercepted: it sees every way in, captured native methods included, and
  // its callback runs before the next paint, so nothing renders clipped first.
  const observer = new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach(lift);
  });
  observer.observe(body, { childList: true });
  signal.addEventListener('abort', () => observer.disconnect(), { once: true });
}
