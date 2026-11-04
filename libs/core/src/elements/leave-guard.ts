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
 * The slots that hold unsaved work under `root`, in document order: inside open shadow roots too,
 * whether a fragment's or a component's (a Lit element, an Angular `ShadowDom` view), and inside
 * other fragments. A router guard asks before leaving a view when this is not empty.
 *
 * `root` itself counts too: a slot, or a component whose view is in its own shadow root — a routed
 * Angular `ShadowDom` component's host element, say.
 */
export function dirtySlots(root: ParentNode = document): DirtySlot[] {
  const found: DirtySlot[] = [];
  const check = (element: Element) => {
    if (element.localName === 'fragment-slot') {
      const dirty = (element as DirtySlot).dirty;
      if (dirty !== null && dirty !== undefined) found.push(element as DirtySlot);
    }
    if (element.shadowRoot) visit(element.shadowRoot);
  };
  const visit = (scope: ParentNode) => {
    for (const element of scope.querySelectorAll('*')) check(element);
  };
  if (root instanceof Element) check(root);
  visit(root);
  return found;
}

/** Asked before a navigation would lose unsaved work: resolve true to leave, false to stay. */
export type ConfirmLeave = (slots: readonly DirtySlot[]) => boolean | Promise<boolean>;

interface NavigateEventLike extends Event {
  readonly cancelable: boolean;
  readonly navigationType: 'push' | 'replace' | 'reload' | 'traverse';
  readonly destination: { readonly url: string; readonly sameDocument: boolean; getState?(): unknown };
  readonly formData: FormData | null;
  readonly downloadRequest: string | null;
}

interface NavigationLike extends EventTarget {
  navigate(url: string, options?: { history?: 'push' | 'replace'; state?: unknown }): unknown;
}

/** How long after a yes `leaveConfirmed()` answers true: long enough for the page to unload. */
const CONFIRMED_FOR_MS = 5_000;
let confirmedAt = -Infinity;

/**
 * Whether the user has just agreed to leave through `confirmLeave`. A host's own `beforeunload`
 * handler checks it, so a navigation the user already said yes to is not asked about a second time
 * by the browser's own prompt:
 *
 * ```ts
 * addEventListener('beforeunload', (event) => { if (dirtySlots().length && !leaveConfirmed()) event.preventDefault(); });
 * ```
 */
export function leaveConfirmed(): boolean {
  return performance.now() - confirmedAt < CONFIRMED_FOR_MS;
}

/**
 * Holds a navigation to another same-origin document while a slot has unsaved work, asks
 * `confirm`, and starts the navigation again if the answer is yes.
 *
 * Only what can be held and started again: a link or `location` change to another document on this
 * origin, by push or replace. Not form posts (their body would be lost), downloads, reloads, or
 * back/forward (which cannot be cancelled across documents). One question at a time: a navigation
 * held while the user is still answering replaces the one being asked about, so a yes goes where they
 * last clicked. Returns a function that removes the guard; a browser without the Navigation API gets
 * none.
 */
export function installLeaveGuard(confirm: ConfirmLeave): () => void {
  const navigation = (globalThis as { navigation?: NavigationLike }).navigation;
  if (!navigation) return () => undefined;

  // the navigation the user agreed to, started again synchronously below: its event passes
  let reissuing = false;
  let pending: { url: string; history: 'push' | 'replace'; state: unknown } | null = null;
  let removed = false;

  const onNavigate = (event: Event) => {
    const navigate = event as NavigateEventLike;
    if (reissuing || !navigate.cancelable || navigate.destination.sameDocument) return;
    if (navigate.navigationType !== 'push' && navigate.navigationType !== 'replace') return;
    if (navigate.formData || navigate.downloadRequest !== null) return;
    if (new URL(navigate.destination.url).origin !== location.origin) return;

    const slots = dirtySlots();
    if (slots.length === 0) return;

    navigate.preventDefault();
    const target = { url: navigate.destination.url, history: navigate.navigationType, state: navigate.destination.getState?.() };
    if (pending) {
      // already asking: this is where a yes now goes
      pending = target;
      return;
    }
    pending = target;
    void Promise.resolve()
      .then(() => confirm(slots))
      .then(
        (leave) => {
          const chosen = pending;
          pending = null;
          if (!leave || !chosen || removed) return;
          confirmedAt = performance.now();
          reissuing = true;
          try {
            navigation.navigate(chosen.url, { history: chosen.history, ...(chosen.state === undefined ? {} : { state: chosen.state }) });
          } finally {
            reissuing = false;
          }
        },
        (error: unknown) => {
          pending = null;
          console.error('[braid] confirmLeave failed; staying on the page', error);
        },
      );
  };

  navigation.addEventListener('navigate', onNavigate);
  return () => {
    removed = true;
    navigation.removeEventListener('navigate', onNavigate);
  };
}
