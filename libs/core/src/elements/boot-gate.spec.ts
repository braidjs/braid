import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initBraid } from '../index.js';
import { createBootGate, parseBootMode } from './boot-gate.js';

const realmFrames = () => document.querySelectorAll('iframe[name^="braid:"]').length;

/** A slot that looks pierced: a shadow root holding a `<braid-document>`, as the gateway writes it. */
function piercedSlot(name: string, boot: string, content = '<a href="/next">Next</a>'): HTMLElement {
  const slot = document.createElement('fragment-slot');
  slot.setAttribute('name', name);
  slot.setAttribute('boot', boot);
  const root = slot.attachShadow({ mode: 'open' });
  const documentRoot = document.createElement('braid-document');
  documentRoot.innerHTML = content;
  root.append(documentRoot);
  return slot;
}

/** Lets the slot's queued boot steps run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('parseBootMode()', () => {
  it('defaults to eager, and falls back to it for an unknown value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseBootMode(null, 'x')).toBe('eager');
    expect(parseBootMode('', 'x')).toBe('eager');
    expect(parseBootMode('visible', 'x')).toBe('visible');
    expect(parseBootMode('later', 'x')).toBe('eager');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown boot="later"'));
    warn.mockRestore();
  });
});

describe('<fragment-slot boot>', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let intersect: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
  let idle: (() => void) | undefined;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('<braid-html></braid-html>', { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);
    intersect = undefined;
    idle = undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          intersect = callback;
        }
        observe() {
          // the test drives intersections itself, through the stored callback
        }
        disconnect() {
          intersect = undefined;
        }
      },
    );
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
      idle = callback;
      return 1;
    });
    vi.stubGlobal('cancelIdleCallback', () => {
      idle = undefined;
    });
    initBraid();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('boots at once without the attribute, as it always has', async () => {
    document.body.innerHTML = '<fragment-slot name="billing"></fragment-slot>';
    await settle();
    expect(realmFrames()).toBe(1);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('visible: creates no realm and fetches nothing until the slot nears the viewport', async () => {
    document.body.innerHTML = '<fragment-slot name="billing" boot="visible"></fragment-slot>';
    await settle();
    expect(realmFrames()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    intersect!([{ isIntersecting: false }]);
    await settle();
    expect(realmFrames()).toBe(0);

    intersect!([{ isIntersecting: true }]);
    await settle();
    expect(realmFrames()).toBe(1);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('idle: waits for the browser to go idle', async () => {
    document.body.innerHTML = '<fragment-slot name="billing" boot="idle"></fragment-slot>';
    await settle();
    expect(realmFrames()).toBe(0);

    idle!();
    await settle();
    expect(realmFrames()).toBe(1);
  });

  it('interaction: a pierced slot boots on the first pointer inside it', async () => {
    const slot = piercedSlot('billing', 'interaction');
    document.body.append(slot);
    await settle();
    expect(realmFrames()).toBe(0);

    slot.shadowRoot!.querySelector('a')!.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    await settle();
    expect(realmFrames()).toBe(1);
  });

  it('interaction: an unpierced slot has nothing to interact with, so it boots when visible', async () => {
    document.body.innerHTML = '<fragment-slot name="billing" boot="interaction"></fragment-slot>';
    await settle();
    expect(realmFrames()).toBe(0);
    expect(intersect).toBeDefined();

    intersect!([{ isIntersecting: true }]);
    await settle();
    expect(realmFrames()).toBe(1);
  });

  it('holds a click before boot and replays it once the fragment is ready', async () => {
    const slot = piercedSlot('billing', 'interaction');
    document.body.append(slot);
    await settle();
    const link = slot.shadowRoot!.querySelector('a')!;
    const seen: boolean[] = [];
    link.addEventListener('click', (event) => seen.push(event.isTrusted));
    const hostSeen = vi.fn();
    slot.addEventListener('click', hostSeen);

    const first = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
    link.dispatchEvent(first);
    // not followed, and not seen by the fragment or the host until it can be handled
    expect(first.defaultPrevented).toBe(true);
    expect(seen).toHaveLength(0);
    expect(hostSeen).not.toHaveBeenCalled();

    slot.dispatchEvent(new CustomEvent('braid:ready', { detail: { fragmentId: 'billing' } }));
    await settle();
    expect(seen).toHaveLength(1);
    expect(hostSeen).toHaveBeenCalledTimes(1);

    // after replay, clicks are the fragment's own again
    const later = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
    link.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
    expect(seen).toHaveLength(2);
  });

  it('drops what it held when the slot leaves the DOM before boot finishes', async () => {
    const slot = piercedSlot('billing', 'interaction');
    document.body.append(slot);
    await settle();
    const link = slot.shadowRoot!.querySelector('a')!;
    const seen = vi.fn();
    link.addEventListener('click', seen);
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));

    slot.remove();
    slot.dispatchEvent(new CustomEvent('braid:ready'));
    await settle();
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('createBootGate()', () => {
  afterEach(() => document.body.replaceChildren());

  it('replays a held submit through requestSubmit, keeping its submitter', async () => {
    const slot = piercedSlot('billing', 'interaction', '<form><button name="go">Go</button></form>');
    document.body.append(slot);
    const gate = createBootGate(slot, 'interaction', { pierced: true, fragmentId: 'billing' });
    const form = slot.shadowRoot!.querySelector('form')!;
    const button = form.querySelector('button')!;
    const requestSubmit = vi.spyOn(form, 'requestSubmit').mockImplementation(() => undefined);

    const submit = new Event('submit', { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(submit, 'submitter', { value: button });
    form.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);

    await gate.triggered;
    gate.replay();
    expect(requestSubmit).toHaveBeenCalledWith(button);
  });

  it('skips a held click whose element was replaced, and warns in dev mode', async () => {
    initBraid({ dev: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const slot = piercedSlot('billing', 'interaction');
    document.body.append(slot);
    const gate = createBootGate(slot, 'interaction', { pierced: true, fragmentId: 'billing' });
    const link = slot.shadowRoot!.querySelector('a')!;
    const seen = vi.fn();
    link.addEventListener('click', seen);
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));

    link.remove();
    gate.replay();
    expect(seen).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('left the DOM'));
    warn.mockRestore();
  });

  it('never fires after dispose', async () => {
    const slot = piercedSlot('billing', 'interaction');
    document.body.append(slot);
    const gate = createBootGate(slot, 'interaction', { pierced: true, fragmentId: 'billing' });
    const fired = vi.fn();
    void gate.triggered.then(fired);
    gate.dispose();
    slot.shadowRoot!.querySelector('a')!.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fired).not.toHaveBeenCalled();
  });
});
