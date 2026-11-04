import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirtySlots, installLeaveGuard, leaveConfirmed } from './leave-guard.js';

/** What the guards read, and how the Navigation API guard holds and restarts a navigation. */

function slot(dirty: string | null, parent: ParentNode = document.body): HTMLElement {
  const element = document.createElement('fragment-slot');
  Object.defineProperty(element, 'dirty', { value: dirty });
  parent.append(element);
  return element;
}

/** A Navigation API stand-in: `navigate()` dispatches its event synchronously, as the browser does. */
class FakeNavigation extends EventTarget {
  readonly navigated: { url: string; options?: { history?: string; state?: unknown } }[] = [];
  navigate(url: string, options?: { history?: 'push' | 'replace'; state?: unknown }) {
    this.navigated.push({ url, ...(options ? { options } : {}) });
    this.fire({ url, navigationType: options?.history ?? 'push' });
  }
  /** Dispatches a navigate event; returns whether it was cancelled. */
  fire(init: { url: string; navigationType?: string; sameDocument?: boolean; formData?: FormData | null; downloadRequest?: string | null; cancelable?: boolean; state?: unknown }): boolean {
    const event = new Event('navigate', { cancelable: init.cancelable ?? true });
    Object.assign(event, {
      navigationType: init.navigationType ?? 'push',
      destination: { url: new URL(init.url, location.href).href, sameDocument: init.sameDocument ?? false, getState: () => init.state },
      formData: init.formData ?? null,
      downloadRequest: init.downloadRequest ?? null,
    });
    this.dispatchEvent(event);
    return event.defaultPrevented;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let remove: (() => void) | undefined;

afterEach(() => {
  remove?.();
  remove = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function guarded(confirm: (slots: readonly HTMLElement[]) => boolean | Promise<boolean>) {
  const navigation = new FakeNavigation();
  vi.stubGlobal('navigation', navigation);
  remove = installLeaveGuard(confirm);
  return navigation;
}

describe('dirtySlots', () => {
  it('finds the slots that hold unsaved work: in fragments, and in components’ shadow roots', () => {
    const outer = slot('outer form');
    slot(null);
    const inner = slot('inner form', outer.attachShadow({ mode: 'open' }));
    // a host component rendering with shadow DOM (Lit, Angular ShadowDom), and one inside a fragment
    const shell = document.createElement('x-shell');
    document.body.append(shell);
    const inShell = slot('in a component', shell.attachShadow({ mode: 'open' }));
    const card = document.createElement('x-card');
    outer.shadowRoot!.append(card);
    const inCard = slot('in a fragment’s component', card.attachShadow({ mode: 'open' }));

    expect(dirtySlots()).toEqual([outer, inner, inCard, inShell]);
  });

  it('looks only under the root it is given', () => {
    const view = document.createElement('main');
    document.body.append(view);
    slot('in the sidebar');
    const mine = slot('in the view', view);

    expect(dirtySlots(view)).toEqual([mine]);
  });
});

describe('installLeaveGuard', () => {
  it('holds a navigation to another document while a slot is dirty, asks, and starts it again on yes', async () => {
    const editing = slot('editing');
    const confirm = vi.fn(async () => true);
    const navigation = guarded(confirm);

    expect(navigation.fire({ url: '/elsewhere', navigationType: 'replace', state: { from: 'test' } })).toBe(true);
    await tick();

    expect(confirm).toHaveBeenCalledWith([editing]);
    // started again once, as it was, and let through rather than held a second time
    expect(navigation.navigated).toEqual([{ url: new URL('/elsewhere', location.href).href, options: { history: 'replace', state: { from: 'test' } } }]);
    expect(leaveConfirmed()).toBe(true);
  });

  it('stays when the answer is no, and when confirm fails', async () => {
    slot('editing');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const no = guarded(() => false);
    no.fire({ url: '/elsewhere' });
    await tick();
    expect(no.navigated).toEqual([]);

    remove?.();
    const fails = guarded(() => Promise.reject(new Error('dialog broke')));
    fails.fire({ url: '/elsewhere' });
    await tick();
    expect(fails.navigated).toEqual([]);
    error.mockRestore();
  });

  it('asks once while the user is answering, and a yes goes where they last clicked', async () => {
    slot('editing');
    let answer!: (leave: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const navigation = guarded(confirm);

    navigation.fire({ url: '/first' });
    await tick();
    expect(navigation.fire({ url: '/second' })).toBe(true);
    answer(true);
    await tick();

    expect(confirm).toHaveBeenCalledOnce();
    expect(navigation.navigated.map((entry) => entry.url)).toEqual([new URL('/second', location.href).href]);
  });

  it('leaves alone what it cannot hold and start again, and anything while nothing is dirty', () => {
    const navigation = guarded(() => false);
    expect(navigation.fire({ url: '/elsewhere' })).toBe(false);

    slot('editing');
    expect(navigation.fire({ url: '/elsewhere', sameDocument: true })).toBe(false);
    expect(navigation.fire({ url: '/elsewhere', formData: new FormData() })).toBe(false);
    expect(navigation.fire({ url: '/report.pdf', downloadRequest: 'report.pdf' })).toBe(false);
    expect(navigation.fire({ url: '/elsewhere', navigationType: 'reload' })).toBe(false);
    expect(navigation.fire({ url: '/elsewhere', navigationType: 'traverse' })).toBe(false);
    expect(navigation.fire({ url: 'https://other.example/' })).toBe(false);
    expect(navigation.fire({ url: '/elsewhere', cancelable: false })).toBe(false);
  });

  it('installs nothing where there is no Navigation API', () => {
    vi.stubGlobal('navigation', undefined);
    const removeNothing = installLeaveGuard(() => true);
    expect(() => removeNothing()).not.toThrow();
  });
});
