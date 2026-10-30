/**
 * Late fragment markup: what the gateway sends at the end of the document for a slot it streamed
 * past (a manifest with `stream: "out-of-order"`).
 *
 * The gateway marks the slot `data-braid-deferred` and, once the fragment answers, emits
 *
 * ```html
 * <braid-late for="billing" hidden><template shadowrootmode="open">…</template></braid-late>
 * ```
 *
 * A declarative shadow root attaches to the element it is parsed in, which by then is no longer the
 * slot, so `<braid-late>` moves its content across. The content is already prepared — scripts inert,
 * URLs re-rooted — so moving it runs nothing, and the slot then adopts it exactly as if it had been
 * pierced in place. A `<braid-late>` with no shadow root means the fragment failed: the slot boots
 * client-side, as any unpierced slot does.
 */

export const DEFERRED_ATTRIBUTE = 'data-braid-deferred';

/** Dispatched on a slot once its late markup, or the news that none is coming, has arrived. */
const LATE_EVENT = 'braid:late';

export class BraidLate extends HTMLElement {
  connectedCallback(): void {
    deliverLateContent(this);
  }
}

export function deliverLateContent(late: HTMLElement): void {
  const fragmentId = late.getAttribute('for') ?? '';
  const slot = [...document.querySelectorAll<HTMLElement>(`fragment-slot[${DEFERRED_ATTRIBUTE}]`)].find(
    (candidate) => candidate.getAttribute('name') === fragmentId,
  );
  // nothing waiting for it: a slot the host removed, or a document that was not composed for it
  if (!slot) {
    late.remove();
    return;
  }

  if (late.shadowRoot) {
    const root = slot.shadowRoot ?? slot.attachShadow({ mode: 'open' });
    root.replaceChildren(...late.shadowRoot.childNodes);
    slot.setAttribute('data-braid-pierced', '');
  } else {
    const reason = late.getAttribute('data-braid-fallback');
    if (reason) slot.setAttribute('data-braid-fallback', reason);
  }
  slot.removeAttribute(DEFERRED_ATTRIBUTE);
  late.remove();
  slot.dispatchEvent(new Event(LATE_EVENT));
}

/**
 * Resolves once a deferred slot can boot: its late markup has been moved in, the gateway said none
 * is coming, or the document finished parsing without either (a response cut short) — in which
 * case the slot simply boots client-side.
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
