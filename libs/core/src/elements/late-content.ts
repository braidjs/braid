import { isDevMode } from '../config.js';

/**
 * Late fragment markup: what the gateway sends at the end of the document for a slot it streamed
 * past (a manifest with `stream: "out-of-order"`).
 *
 * The gateway marks the slot `data-braid-deferred="<token>"` and, once the fragment answers, emits
 *
 * ```html
 * <braid-late for="billing" token="<token>" hidden>
 *   <template shadowrootmode="open">…</template><braid-late-end></braid-late-end>
 * </braid-late>
 * ```
 *
 * A declarative shadow root attaches to the element it is parsed in, which by then is no longer the
 * slot, so the content is moved across. It is already prepared — scripts inert, URLs re-rooted — so
 * moving it runs nothing, and the slot then adopts it exactly as if it had been pierced in place.
 *
 * **When.** A custom element's callbacks run at its start tag, before that shadow root exists, so a
 * runtime loaded early delivers when `<braid-late-end>` is parsed. A runtime loaded after parsing
 * finds the shadow root already attached when it upgrades `<braid-late>`, and delivers then. A
 * `<braid-late data-braid-empty>` carries no content: the fragment failed, and the slot boots
 * client-side.
 *
 * **Whose.** Only markup the gateway wrote may fill a slot. The token must match the slot's (it is
 * minted per response, so no fragment can know it), and the element must sit directly in `<body>`,
 * after the slot — where the gateway puts it, and where a fragment's own markup, which lives in a
 * shadow root, never is. Anything else is removed unread.
 */

export const DEFERRED_ATTRIBUTE = 'data-braid-deferred';

/** Dispatched on a slot once its late markup, or the news that none is coming, has arrived. */
const LATE_EVENT = 'braid:late';

export class BraidLate extends HTMLElement {
  connectedCallback(): void {
    // while parsing, the content has not arrived yet; `<braid-late-end>` delivers it
    if (this.hasAttribute('data-braid-empty') || this.shadowRoot) deliverLateContent(this);
  }
}

export class BraidLateEnd extends HTMLElement {
  connectedCallback(): void {
    const late = this.parentElement;
    if (late?.localName === 'braid-late') deliverLateContent(late);
    else this.remove();
  }
}

export function deliverLateContent(late: HTMLElement): void {
  // delivered once: by `<braid-late-end>` or on upgrade, whichever comes first
  if (!late.isConnected) return;

  const fragmentId = late.getAttribute('for') ?? '';
  const token = late.getAttribute('token');
  const slot = [...document.querySelectorAll<HTMLElement>(`fragment-slot[${DEFERRED_ATTRIBUTE}]`)].find(
    (candidate) => candidate.getAttribute('name') === fragmentId,
  );
  const genuine =
    slot !== undefined &&
    Boolean(token) &&
    slot.getAttribute(DEFERRED_ATTRIBUTE) === token &&
    late.parentNode === document.body &&
    Boolean(slot.compareDocumentPosition(late) & Node.DOCUMENT_POSITION_FOLLOWING);
  late.remove();

  // nothing waiting for it: a slot the host removed or reloaded, or a page not composed for it
  if (!slot) return;
  if (!genuine) {
    if (isDevMode()) console.warn(`[braid:${fragmentId}] ignored late markup the gateway did not send for this slot`);
    return;
  }

  if (late.shadowRoot && !late.hasAttribute('data-braid-empty')) {
    const root = slot.shadowRoot ?? slot.attachShadow({ mode: 'open' });
    root.replaceChildren(...late.shadowRoot.childNodes);
    slot.setAttribute('data-braid-pierced', '');
  } else {
    const reason = late.getAttribute('data-braid-fallback');
    if (reason) slot.setAttribute('data-braid-fallback', reason);
  }
  slot.removeAttribute(DEFERRED_ATTRIBUTE);
  slot.dispatchEvent(new Event(LATE_EVENT));
}

/**
 * Resolves once a deferred slot can boot: its late markup has been moved in, the gateway said none
 * is coming, or the document finished parsing without either (a response cut short) — in which
 * case the slot simply boots client-side.
 *
 * Its `DOMContentLoaded` listener is the one listener Braid puts on the host document, and only
 * while a deferred slot waits on a document that is still being parsed.
 */
export function lateContentArrival(slot: HTMLElement): Promise<void> {
  if (!slot.hasAttribute(DEFERRED_ATTRIBUTE)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      slot.removeEventListener(LATE_EVENT, done);
      document.removeEventListener('DOMContentLoaded', done);
      slot.removeAttribute(DEFERRED_ATTRIBUTE);
      resolve();
    };
    slot.addEventListener(LATE_EVENT, done);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', done);
    else queueMicrotask(done);
  });
}
