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
 * the fragment's own listeners. Removing the element closes it; appending it again shows it again.
 *
 * Opt-in, because it changes positioning: a lifted element is laid out against the page rather
 * than the slot (see `OVERLAY_STYLES`), and stacks by the order it was shown, not its `z-index`.
 */

/** Marks an element the slot lifted, so a popover of the fragment's own is never mistaken for one. */
export const OVERLAY_ATTRIBUTE = 'data-braid-overlay';

/**
 * Undoes the browser's popover look (centred, bordered, padded, opaque) so a lifted portal looks as
 * it did in the body, laid out from the page's origin as a body child would be. `inset: auto`
 * rather than zeros, so a portal anchored by `right` or `bottom` alone does not stretch. Zero
 * specificity: any rule of the fragment's own, or its inline style, wins.
 */
export const OVERLAY_STYLES =
  `:where([${OVERLAY_ATTRIBUTE}]) { position: absolute; inset: auto; margin: 0; padding: 0; border: 0; ` +
  'background: none; color: inherit; overflow: visible; width: auto; height: auto; max-width: none; max-height: none; }';

/**
 * Body children that are not overlays: they render nothing, a `<dialog>` has the top layer of its
 * own through `showModal()`, and Braid's elements are Braid's.
 */
const NOT_OVERLAYS = new Set(['script', 'style', 'link', 'template', 'meta', 'noscript', 'dialog']);

/**
 * Lifts each element appended to the fragment's body from now on. Stops when `signal` aborts (the
 * fragment closes). Does nothing for a fragment with no body (a custom-element fragment) or in a
 * browser without popovers.
 */
export function liftPortals(contentRoot: HTMLElement, signal: AbortSignal): void {
  // the element the fragment's realm answers `document.body` with (see document-overrides.ts)
  const body = contentRoot.querySelector('braid-body') ?? contentRoot.firstElementChild;
  if (!body || typeof HTMLElement.prototype.showPopover !== 'function') return;
  adoptOverlayStyles(contentRoot);

  const lift = (node: Node) => {
    if (!(node instanceof HTMLElement) || node.parentNode !== body) return;
    if (NOT_OVERLAYS.has(node.localName) || node.localName.startsWith('braid-')) return;
    const ours = node.hasAttribute(OVERLAY_ATTRIBUTE);
    // a popover the fragment declared itself is the fragment's to show
    if (node.hasAttribute('popover') && !ours) return;
    node.setAttribute('popover', 'manual');
    try {
      node.showPopover();
      node.setAttribute(OVERLAY_ATTRIBUTE, '');
    } catch {
      // removed again before this ran, or not showable: leave it as the fragment made it
      node.removeAttribute('popover');
      node.removeAttribute(OVERLAY_ATTRIBUTE);
    }
  };

  /**
   * One the fragment moved out of its body, into its app, is an overlay no longer: left a closed
   * popover, it would never render again.
   */
  const settle = (node: Node) => {
    if (!(node instanceof HTMLElement) || !node.hasAttribute(OVERLAY_ATTRIBUTE)) return;
    queueMicrotask(() => {
      if (node.isConnected && node.parentNode !== body) {
        node.removeAttribute('popover');
        node.removeAttribute(OVERLAY_ATTRIBUTE);
      }
    });
  };

  // Observed rather than intercepted: it sees every way in, captured native methods included, and
  // its callback runs before the next paint, so nothing renders clipped first. (A synchronous
  // measurement straight after `appendChild` still sees the element where it was appended.)
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      record.removedNodes.forEach(settle);
      record.addedNodes.forEach(lift);
    }
  });
  observer.observe(body, { childList: true });
  signal.addEventListener('abort', () => observer.disconnect(), { once: true });
}

/**
 * Shows again what the slot lifted. A move that disconnected the slot closed every open popover in
 * it, and nothing was appended to the body for the observer to notice.
 */
export function reshowLifted(contentRoot: HTMLElement): void {
  for (const element of contentRoot.querySelectorAll<HTMLElement>(`[${OVERLAY_ATTRIBUTE}]`)) {
    try {
      if (!element.matches(':popover-open')) element.showPopover();
    } catch {
      // not showable now: it stays as the fragment left it
    }
  }
}

/**
 * The reset, adopted into the slot's shadow root: a client-rendered slot and a server-rendered
 * (pierced) one alike, whatever stylesheet the gateway wrote — and with no inline `<style>` for a
 * strict CSP to refuse.
 */
function adoptOverlayStyles(contentRoot: HTMLElement): void {
  const root = Node.prototype.getRootNode.call(contentRoot);
  if (!(root instanceof ShadowRoot) || typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in root)) return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(OVERLAY_STYLES);
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
}
