/**
 * Asking before a navigation loses a fragment's unsaved work.
 *
 * A fragment declares unsaved work with `env.setDirty(reason)`, and the slot holds it as `dirty`,
 * so the question "would leaving lose anything?" has a synchronous answer. These helpers put that
 * answer where a navigation can be held: a host router's own guard ({@link dirtySlots}), and, for
 * navigations that leave the document, the Navigation API's `navigate` event.
 *
 * Holding a navigation inside a single-page app is the router's job, not this one: cancelling a
 * router's own `pushState` leaves the router believing it navigated. So the event listener here
 * holds only navigations that load another document, which no router is part of.
 */

/** A slot as far as the guard needs one. */
export interface DirtySlot extends HTMLElement {
  readonly dirty: string | null;
}

/**
 * The slots that hold unsaved work, in document order, including slots nested inside other
 * fragments. A router guard asks before leaving a view when this is not empty.
 */
export function dirtySlots(root: ParentNode = document): DirtySlot[] {
  const found: DirtySlot[] = [];
  for (const slot of root.querySelectorAll<DirtySlot>('fragment-slot')) {
    if (slot.dirty !== null && slot.dirty !== undefined) found.push(slot);
    if (slot.shadowRoot) found.push(...dirtySlots(slot.shadowRoot));
  }
  return found;
}

/** Asked before a navigation would lose unsaved work: resolve true to leave, false to stay. */
export type ConfirmLeave = (slots: readonly DirtySlot[]) => boolean | Promise<boolean>;

interface NavigateEventLike extends Event {
  readonly cancelable: boolean;
  readonly navigationType: 'push' | 'replace' | 'reload' | 'traverse';
  readonly destination: { readonly url: string; readonly sameDocument: boolean };
  readonly formData: FormData | null;
  readonly downloadRequest: string | null;
}

interface NavigationLike extends EventTarget {
  navigate(url: string, options?: { history?: 'push' | 'replace' }): unknown;
}

/**
 * Holds a navigation to another same-origin document while a slot has unsaved work, asks
 * `confirm`, and starts the navigation again if the answer is yes.
 *
 * Only what can be held and started again: a link or `location` change to another document on this
 * origin, by push or replace. Not form posts (their body would be lost), downloads, reloads, or
 * back/forward (which cannot be cancelled across documents). A page that leaves anyway still
 * meets the host's `beforeunload` handler, if it has one. Returns a function that removes the guard;
 * a browser without the Navigation API gets none.
 */
export function installLeaveGuard(confirm: ConfirmLeave): () => void {
  const navigation = (globalThis as { navigation?: NavigationLike }).navigation;
  if (!navigation) return () => undefined;

  // the navigation the user agreed to, started again: let it through once
  let allowed: string | null = null;

  const onNavigate = (event: Event) => {
    const navigate = event as NavigateEventLike;
    if (!navigate.cancelable || navigate.destination.sameDocument) return;
    if (navigate.navigationType !== 'push' && navigate.navigationType !== 'replace') return;
    if (navigate.formData || navigate.downloadRequest !== null) return;
    if (new URL(navigate.destination.url).origin !== location.origin) return;
    if (allowed === navigate.destination.url) {
      allowed = null;
      return;
    }

    const slots = dirtySlots();
    if (slots.length === 0) return;

    navigate.preventDefault();
    const { url } = navigate.destination;
    const history = navigate.navigationType;
    void Promise.resolve()
      .then(() => confirm(slots))
      .then((leave) => {
        if (!leave) return;
        allowed = url;
        navigation.navigate(url, { history });
      })
      .catch((error: unknown) => console.error('[braid] confirmLeave failed; staying on the page', error));
  };

  navigation.addEventListener('navigate', onNavigate);
  return () => navigation.removeEventListener('navigate', onNavigate);
}
