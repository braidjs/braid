import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirtySlots, installLeaveGuard } from './leave-guard.js';

/** What the guards read: the slots holding unsaved work, wherever they are composed. */

function slot(dirty: string | null, parent: ParentNode = document.body): HTMLElement {
  const element = document.createElement('fragment-slot');
  Object.defineProperty(element, 'dirty', { value: dirty });
  parent.append(element);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('dirtySlots', () => {
  it('finds the slots that hold unsaved work, including those inside other fragments', () => {
    const outer = slot('outer form');
    slot(null);
    const shadow = outer.attachShadow({ mode: 'open' });
    const inner = slot('inner form', shadow);
    slot(null, shadow);

    expect(dirtySlots()).toEqual([outer, inner]);
  });

  it('is empty when nothing is unsaved', () => {
    slot(null);
    expect(dirtySlots()).toEqual([]);
  });
});

describe('installLeaveGuard', () => {
  it('installs nothing where there is no Navigation API', () => {
    vi.stubGlobal('navigation', undefined);
    const remove = installLeaveGuard(() => true);
    expect(() => remove()).not.toThrow();
  });
});
