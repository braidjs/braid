import { afterEach, describe, expect, it, vi } from 'vitest';
import { customElementAdapter } from './custom-element-adapter.js';
import { BraidError } from '../errors.js';
import type { AdapterBootContext } from './adapter.js';
import type { RealmHandle } from '../realm/realm-manager.js';

/**
 * The adapter is contract-mode: it touches `env` and the realm, and nothing else. These build a
 * stand-in realm whose `evaluate` defines an element in a *separate* registry, which is the
 * situation the adapter exists to handle.
 */

function makeContext(
  adapterOptions: Record<string, unknown>,
  overrides: { defineElement?: boolean; props?: Record<string, unknown> } = {},
): {
  ctx: AdapterBootContext;
  root: HTMLElement;
  emitted: { type: string; detail: unknown }[];
  controller: AbortController;
  propsListeners: ((props: Record<string, unknown>) => void)[];
} {
  const root = document.createElement('braid-document');
  document.body.append(root);

  const registry = new Map<string, boolean>();
  const emitted: { type: string; detail: unknown }[] = [];
  const propsListeners: ((props: Record<string, unknown>) => void)[] = [];
  const controller = new AbortController();

  const realm = {
    kind: 'compat-http',
    window: { customElements: { get: (tag: string) => (registry.get(tag) ? class {} : undefined) } },
    // the "realm document" here is the same document; the adoption behavior it stands in for is
    // covered by the browser verification in the POC rather than by jsdom
    document,
    manifestAdapter: 'custom-element',
    adapterOptions,
    evaluate: vi.fn(async (entry: string) => {
      if (overrides.defineElement !== false) registry.set(String(adapterOptions['element']), true);
      void entry;
    }),
    evaluateModule: vi.fn(),
    dispose: vi.fn(),
  } as unknown as RealmHandle;

  const ctx = {
    fragmentId: 'rating',
    realm,
    signal: controller.signal,
    env: {
      root,
      props: overrides.props ?? {},
      onPropsChanged: (listener: (props: Record<string, unknown>) => void) => {
        propsListeners.push(listener);
        return () => undefined;
      },
      emit: (type: string, detail: unknown) => emitted.push({ type, detail }),
    },
  } as unknown as AdapterBootContext;

  return { ctx, root, emitted, controller, propsListeners };
}

describe('custom-element adapter', () => {
  it('evaluates the entry module and mounts the declared element', async () => {
    const { ctx, root } = makeContext({ entry: '/widget.js', element: 'star-rating' });

    await customElementAdapter.boot(ctx);

    expect(ctx.realm.evaluate).toHaveBeenCalledWith('/widget.js');
    expect(root.querySelector('star-rating')).not.toBeNull();
  });

  it('assigns props as properties, not attributes', async () => {
    const { ctx, root } = makeContext(
      { entry: '/widget.js', element: 'star-rating' },
      { props: { value: 4, label: 'Quality' } },
    );

    await customElementAdapter.boot(ctx);
    const element = root.querySelector('star-rating') as HTMLElement & { value?: number };

    expect(element.value).toBe(4);
    expect(element.hasAttribute('value')).toBe(false);
  });

  it('keeps the element in sync with later props', async () => {
    const { ctx, root, propsListeners } = makeContext({ entry: '/widget.js', element: 'star-rating' });

    await customElementAdapter.boot(ctx);
    propsListeners.forEach((listener) => listener({ value: 9 }));

    expect((root.querySelector('star-rating') as HTMLElement & { value?: number }).value).toBe(9);
  });

  it('republishes declared element events to the host', async () => {
    const { ctx, root, emitted } = makeContext({
      entry: '/widget.js',
      element: 'star-rating',
      events: ['rating:change'],
    });

    await customElementAdapter.boot(ctx);
    root
      .querySelector('star-rating')!
      .dispatchEvent(new CustomEvent('rating:change', { detail: { value: 5 } }));

    expect(emitted).toEqual([{ type: 'rating:change', detail: { value: 5 } }]);
  });

  it('does not forward events the manifest did not declare', async () => {
    const { ctx, root, emitted } = makeContext({ entry: '/widget.js', element: 'star-rating' });

    await customElementAdapter.boot(ctx);
    root.querySelector('star-rating')!.dispatchEvent(new CustomEvent('rating:change'));

    expect(emitted).toEqual([]);
  });

  it('removes the element when the fragment is torn down', async () => {
    const { ctx, root, controller } = makeContext({ entry: '/widget.js', element: 'star-rating' });

    await customElementAdapter.boot(ctx);
    controller.abort();

    expect(root.querySelector('star-rating')).toBeNull();
  });

  it('names the missing manifest fields rather than failing obscurely', async () => {
    const { ctx } = makeContext({ entry: '/widget.js' });

    await expect(customElementAdapter.boot(ctx)).rejects.toThrow(BraidError);
    await expect(customElementAdapter.boot(ctx)).rejects.toThrow(/"entry" and "element"/);
  });

  it('reports when the entry module never defined the element', async () => {
    const { ctx } = makeContext({ entry: '/widget.js', element: 'star-rating' }, { defineElement: false });

    await expect(customElementAdapter.boot(ctx)).rejects.toThrow(/did not define a custom element/);
  });
});

/**
 * A custom element runs in its own realm too, so without shared globals its analytics land in a
 * realm-local `dataLayer` exactly as a compat fragment's did. These use a real same-origin iframe
 * as the realm, because the claim under test is about which window a script's globals resolve to.
 */
describe('custom-element adapter and shared globals', () => {
  const host = window as unknown as Record<string, unknown>;
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    cleanup.splice(0).forEach((step) => step());
    delete host.dataLayer;
    delete host._satellite;
  });

  function realmContext(sharedGlobals: readonly string[] | undefined, script: string, realmGlobals?: Record<string, unknown>) {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const realmWindow = frame.contentWindow as Window & typeof globalThis;
    const root = document.createElement('braid-document');
    document.body.append(root);
    cleanup.push(() => frame.remove(), () => root.remove());

    const realm = {
      kind: 'compat-http',
      fragmentId: 'rating',
      window: realmWindow,
      document: realmWindow.document,
      manifestAdapter: 'custom-element',
      adapterOptions: { entry: '/widget.js', element: 'star-rating' },
      // stands in for the entry module: runs in the realm, defines the element, uses a global
      evaluate: vi.fn(async () => {
        const element = realmWindow.document.createElement('script');
        element.textContent = `customElements.define('star-rating', class extends HTMLElement {}); ${script}`;
        realmWindow.document.body.append(element);
      }),
      evaluateModule: vi.fn(),
      dispose: vi.fn(),
    } as unknown as RealmHandle;

    const ctx = {
      fragmentId: 'rating',
      realm,
      contentRoot: root,
      signal: new AbortController().signal,
      ...(sharedGlobals === undefined ? {} : { sharedGlobals }),
      ...(realmGlobals === undefined ? {} : { realmGlobals }),
      env: { root, props: {}, onPropsChanged: () => () => undefined, emit: () => undefined },
    } as unknown as AdapterBootContext;

    return { ctx, realmWindow };
  }

  /** Everything a fragment could have reached on the host: its own globals and the DOM prototypes. */
  function hostSurface() {
    const ownSurface = (target: object) =>
      Object.entries(Object.getOwnPropertyDescriptors(target)).map(([key, d]) => [key, d.value ?? d.get ?? d.set]);
    return {
      window: ownSurface(window),
      prototypes: [Node, Element, HTMLElement, Document, EventTarget, History].map((type) => ownSurface(type.prototype)),
    };
  }

  it("lands the element's analytics push in the host's data layer, and touches nothing else on the host", async () => {
    const hostDataLayer: unknown[] = [];
    host.dataLayer = hostDataLayer;
    // `_satellite` is shared but the host has not loaded it yet, so an accessor installed on the
    // wrong window would show up as a new host property
    const { ctx, realmWindow } = realmContext(['dataLayer', '_satellite'], `dataLayer.push({ event: 'rating:ready' });`);
    const before = hostSurface();

    await customElementAdapter.boot(ctx);

    expect(hostDataLayer).toEqual([{ event: 'rating:ready' }]);
    expect(Object.getOwnPropertyDescriptor(realmWindow, 'dataLayer')?.get).toBeTypeOf('function');
    expect(Object.getOwnPropertyDescriptor(realmWindow, '_satellite')?.get).toBeTypeOf('function');
    // the accessors live on the realm; the host's window and prototypes are exactly as they were
    expect(hostSurface()).toEqual(before);
    expect('_satellite' in window).toBe(false);
    expect(Object.getOwnPropertyDescriptor(window, 'dataLayer')?.value).toBe(hostDataLayer);
  });

  it('shares nothing when the slot passes no list', async () => {
    host.dataLayer = [];
    const { ctx, realmWindow } = realmContext(undefined, `var dataLayer = [{ event: 'local' }];`);

    await customElementAdapter.boot(ctx);

    expect(host.dataLayer).toEqual([]);
    expect((realmWindow as unknown as { dataLayer: unknown[] }).dataLayer).toEqual([{ event: 'local' }]);
  });

  it("defines realm globals before the entry module runs, on the realm and not the host", async () => {
    const seen: unknown[] = [];
    const agent = { report: (value: unknown) => seen.push(value) };
    const { ctx, realmWindow } = realmContext(undefined, `fdc3.report(typeof fdc3);`, { fdc3: agent });

    await customElementAdapter.boot(ctx);

    expect(seen).toEqual(['object']);
    expect((realmWindow as unknown as { fdc3: unknown }).fdc3).toBe(agent);
    expect('fdc3' in window).toBe(false);
  });
});
