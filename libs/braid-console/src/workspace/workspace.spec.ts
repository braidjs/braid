// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@finos/fdc3-context';
import type { DesktopAgent } from '@finos/fdc3-standard';
import type { FragmentManifest } from '@braidlabs/gateway';
import { createRegistryApi, createSnapshot, memorySnapshotStore } from '@braidlabs/registry';
import { createBraidDesktopAgent, type BraidDesktopAgentOptions, type IntentResolverHook } from '@braidlabs/fdc3';
import { memoryStore, type PreferenceStore } from './store.js';
import { createWorkspace, type BraidDesktopApi, type Workspace } from './workspace.js';

/**
 * The workspace — preferences, remembered choices, settings and layouts — composed around a real
 * FDC3 agent, and then with no agent at all, against a container that boots slots the way
 * `<fragment-slot>` does: each slot that connects asks the page's `realmGlobals` for its globals
 * with its name, its signal and itself. The real element is exercised in Chromium by
 * e2e/workspace.e2e.ts.
 */

const instrument: Context = { type: 'fdc3.instrument', id: { ticker: 'AAPL' } };

const manifests: FragmentManifest[] = [
  {
    id: 'billing',
    endpoint: 'https://billing.internal',
    title: 'Billing',
    fdc3: { listensFor: { ViewInvoice: { contexts: ['fdc3.instrument'] } } },
  },
  { id: 'blotter', endpoint: 'https://blotter.internal', title: 'Blotter' },
  {
    id: 'research',
    endpoint: 'https://research.internal',
    title: 'Research',
    fdc3: { listensFor: { ViewInvoice: { contexts: ['fdc3.instrument'] }, ViewResearch: { contexts: ['fdc3.instrument'] } } },
  },
];

async function registryDirectory() {
  const snapshot = await createSnapshot({ manifests });
  const store = memorySnapshotStore([snapshot]);
  await store.setHead?.(snapshot.id);
  const api = createRegistryApi({ store, appd: { origin: 'https://portal.example' } });
  const response = await api.handle(new Request('https://ops.example/__braid/registry-api/appd/v2/apps'));
  return (await response!.json()).applications;
}

interface FakeSlot {
  localName: 'fragment-slot';
  attributes: Map<string, string>;
  props?: Record<string, unknown>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  remove(): void;
  /** Resolves with what the agent gave the fragment once it has booted. */
  booted: Promise<Globals>;
  controller: AbortController;
}

type Globals = { fdc3?: DesktopAgent; braidDesktop: BraidDesktopApi };
type Hook = ReturnType<Workspace['realmGlobals']>;

/** A container whose slots boot against `hook()` when appended, as `<fragment-slot>` would. */
function fakeContainer(hook: () => Hook) {
  const children: FakeSlot[] = [];
  const container = {
    children,
    ownerDocument: {
      createElement(localName: string): FakeSlot {
        expect(localName).toBe('fragment-slot');
        let boot!: (value: Awaited<FakeSlot['booted']>) => void;
        const slot: FakeSlot = {
          localName: 'fragment-slot',
          attributes: new Map(),
          getAttribute: (name) => slot.attributes.get(name) ?? null,
          setAttribute: (name, value) => void slot.attributes.set(name, value),
          removeAttribute: (name) => void slot.attributes.delete(name),
          remove() {
            children.splice(children.indexOf(slot), 1);
            slot.controller.abort();
          },
          booted: new Promise((resolve) => (boot = resolve)),
          controller: new AbortController(),
        };
        (slot as unknown as { boot: typeof boot }).boot = boot;
        return slot;
      },
    },
    /** A move within the page: the slot keeps running, so nothing is aborted or booted again. */
    insertBefore(slot: FakeSlot, before: FakeSlot | null) {
      children.splice(children.indexOf(slot), 1);
      const at = before ? children.indexOf(before) : children.length;
      children.splice(at === -1 ? children.length : at, 0, slot);
      return slot;
    },
    append(slot: FakeSlot) {
      children.push(slot);
      teardown.push(slot.controller);
      const props = slot.getAttribute('props');
      if (props) slot.props = JSON.parse(props);
      // a fragment boots after its slot connects, a task or more later
      setTimeout(async () => {
        const globals = await hook()({
          fragmentId: slot.getAttribute('name')!,
          signal: slot.controller.signal,
          slot: slot as unknown as Element,
        });
        (slot as unknown as { boot: (value: unknown) => void }).boot(globals);
      }, 5);
    },
  };
  return container;
}

const teardown: AbortController[] = [];
afterEach(() => teardown.splice(0).forEach((controller) => controller.abort()));

async function setup(
  options: { store?: PreferenceStore; resolveIntent?: BraidDesktopAgentOptions['resolveIntent']; withContainer?: boolean; fdc3?: boolean } = {},
) {
  const store = options.store ?? memoryStore();
  // the container's slots boot later, against the hook composed just below
  const container = fakeContainer(() => realmGlobals);
  const area = options.withContainer === false ? {} : { container: container as unknown as Element };
  const workspace = createWorkspace({ store, container: null, ...area });
  const agent =
    options.fdc3 === false
      ? undefined
      : createBraidDesktopAgent({
          directory: await registryDirectory(),
          // as a host wires it: the area looked up at each launch, hidden apps filtered, the resolver wrapped
          ...workspace.fdc3(options.resolveIntent || undefined),
          ...(options.withContainer === false ? { container: undefined } : {}),
          ...(options.resolveIntent ? {} : { resolveIntent: false as const }),
        });
  const realmGlobals = workspace.realmGlobals(agent?.realmGlobals);
  /** A fragment the host mounted itself, not in the workspace area. */
  const mount = async (fragmentId: string) => {
    const controller = new AbortController();
    teardown.push(controller);
    const globals = (await realmGlobals({ fragmentId, signal: controller.signal })) as Globals;
    return { fdc3: globals.fdc3!, braidDesktop: globals.braidDesktop, unmount: () => controller.abort() };
  };
  /** Mounts into the area, as the host's own markup would, and waits for the boot. */
  const place = async (fragmentId: string, attributes: Record<string, string> = {}) => {
    const slot = container.ownerDocument.createElement('fragment-slot');
    slot.setAttribute('name', fragmentId);
    for (const [name, value] of Object.entries(attributes)) slot.setAttribute(name, value);
    container.append(slot);
    const globals = await slot.booted;
    return { slot, fdc3: globals.fdc3!, braidDesktop: globals.braidDesktop };
  };
  return { workspace, container, mount, place, store };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe('resolving intents', () => {
  async function twoListeners(options: Parameters<typeof setup>[0] = {}) {
    const ctx = await setup({ withContainer: false, ...options });
    const blotter = (await ctx.mount('blotter')).fdc3;
    const billing = vi.fn(async () => undefined);
    const research = vi.fn(async () => undefined);
    await (await ctx.mount('billing')).fdc3.addIntentListener('ViewInvoice', billing);
    await (await ctx.mount('research')).fdc3.addIntentListener('ViewInvoice', research);
    return { ...ctx, blotter, billing, research };
  }

  it('remembers a choice, goes straight to it next time, and asks again once forgotten', async () => {
    const resolveIntent = vi.fn(async ({ candidates }) => ({
      candidate: candidates.find((c: { appId: string }) => c.appId === 'billing')!,
      remember: true,
    }));
    const { workspace, blotter, billing } = await twoListeners({ resolveIntent });

    await blotter.raiseIntent('ViewInvoice', instrument);
    await blotter.raiseIntent('ViewInvoice', instrument);
    await settle();
    expect(resolveIntent).toHaveBeenCalledTimes(1);
    expect(billing).toHaveBeenCalledTimes(2);
    expect(await workspace.preferences.intentChoice('ViewInvoice', 'fdc3.instrument')).toBe('billing');

    await workspace.preferences.forgetIntentChoice('ViewInvoice', 'fdc3.instrument');
    await blotter.raiseIntent('ViewInvoice', instrument);
    expect(resolveIntent).toHaveBeenCalledTimes(2);
  });

  it('asks again when the remembered app is no longer a candidate', async () => {
    const store = memoryStore();
    await store.set('intents/ViewInvoice/fdc3.instrument', { appId: 'gone' });
    const resolveIntent = vi.fn(async ({ candidates }) => ({ candidate: candidates[0] }));
    const { blotter } = await twoListeners({ resolveIntent, store });
    await blotter.raiseIntent('ViewInvoice', instrument);
    expect(resolveIntent).toHaveBeenCalledTimes(1);
  });

  it('never offers a hidden app, so one visible candidate is chosen without asking', async () => {
    const store = memoryStore();
    await store.set('host', { hiddenApps: ['billing'] });
    const resolveIntent = vi.fn(async () => undefined);
    const { blotter, research, billing } = await twoListeners({ resolveIntent, store });

    const resolution = await blotter.raiseIntent('ViewInvoice', instrument);
    await settle();
    expect(resolution.source.appId).toBe('research');
    expect(resolveIntent).not.toHaveBeenCalled();
    expect(research).toHaveBeenCalledTimes(1);
    expect(billing).not.toHaveBeenCalled();
  });

  it('offers no hidden app to the resolver, and cancels when every candidate is hidden', async () => {
    const store = memoryStore();
    await store.set('host', { hiddenApps: ['billing'] });
    const resolveIntent = vi.fn<IntentResolverHook>(async () => undefined);
    const { mount } = await setup({ resolveIntent, store });
    const blotter = (await mount('blotter')).fdc3;
    await (await mount('billing')).fdc3.addIntentListener('ViewInvoice', async () => undefined);
    await (await mount('research')).fdc3.addIntentListener('ViewInvoice', async () => undefined);
    await (await mount('research')).fdc3.addIntentListener('ViewInvoice', async () => undefined);

    await expect(blotter.raiseIntent('ViewInvoice', instrument)).rejects.toThrow('UserCancelledResolution');
    expect(resolveIntent.mock.calls[0][0].candidates.map((candidate) => candidate.appId)).toEqual(['research', 'research']);

    const all = await setup({ resolveIntent, store });
    await all.workspace.preferences.setHost({ hiddenApps: ['billing', 'research'] });
    const raiser = (await all.mount('blotter')).fdc3;
    await (await all.mount('billing')).fdc3.addIntentListener('ViewInvoice', async () => undefined);
    await (await all.mount('research')).fdc3.addIntentListener('ViewInvoice', async () => undefined);
    await expect(raiser.raiseIntent('ViewInvoice', instrument)).rejects.toThrow('UserCancelledResolution');
    expect(resolveIntent).toHaveBeenCalledTimes(1);
  });

  it('hides apps from the choice, not from delivery: the only app able to take an intent still gets it', async () => {
    const store = memoryStore();
    await store.set('host', { hiddenApps: ['research'] });
    const resolveIntent = vi.fn<IntentResolverHook>(async () => undefined);
    const { mount } = await setup({ store, resolveIntent });
    const blotter = (await mount('blotter')).fdc3;
    const handled = vi.fn(async () => undefined);
    await (await mount('research')).fdc3.addIntentListener('ViewResearch', handled);
    expect((await blotter.raiseIntent('ViewResearch', instrument)).source.appId).toBe('research');
    expect(resolveIntent).not.toHaveBeenCalled();
  });

  it('keeps nothing when the resolver answers with something it was not offered', async () => {
    const { blotter, workspace } = await twoListeners({
      resolveIntent: async () => ({ candidate: { intent: 'ViewInvoice', appId: 'blotter', title: 'x' }, remember: true }),
    });
    await expect(blotter.raiseIntent('ViewInvoice', instrument)).rejects.toThrow('UserCancelledResolution');
    expect(await workspace.preferences.intentChoice('ViewInvoice', 'fdc3.instrument')).toBeUndefined();
  });
});

describe('host preferences', () => {
  it('joins every fragment to the default user channel before handing it over', async () => {
    const { workspace, mount } = await setup();
    await workspace.preferences.setHost({ defaultUserChannel: 'fdc3.channel.3' });
    expect(await workspace.preferences.getHost()).toEqual({ defaultUserChannel: 'fdc3.channel.3' });

    const blotter = (await mount('blotter')).fdc3;
    const billing = (await mount('billing')).fdc3;
    expect((await blotter.getCurrentChannel())?.id).toBe('fdc3.channel.3');
    const received = vi.fn();
    await billing.addContextListener('fdc3.instrument', received);
    await blotter.broadcast(instrument);
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(instrument, expect.anything()));
  });

  it('reads the page preferences once, and connects without them when the store stalls', async () => {
    const backing = memoryStore();
    await backing.set('host', { defaultUserChannel: 'fdc3.channel.5' });
    const get = vi.fn((key: string) => backing.get(key));
    const { mount } = await setup({ store: { ...backing, get } });
    await mount('blotter');
    await mount('billing');
    expect(get.mock.calls.filter(([key]) => key === 'host')).toHaveLength(1);

    const stalled = await setup({ store: { ...memoryStore(), get: () => new Promise(() => undefined) } });
    const started = Date.now();
    expect(await (await stalled.mount('blotter')).fdc3.getCurrentChannel()).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('connects fragments with no preferences when the store fails', async () => {
    const broken: PreferenceStore = { ...memoryStore(), get: () => Promise.reject(new Error('down')) };
    const { mount } = await setup({ store: broken });
    expect(await (await mount('blotter')).fdc3.getCurrentChannel()).toBeNull();
  });
});

describe('app settings', () => {
  it("keeps each app's settings apart, and shares them between its instances", async () => {
    const { mount } = await setup();
    const billing = (await mount('billing')).braidDesktop;
    const research = (await mount('research')).braidDesktop;
    const otherBilling = (await mount('billing')).braidDesktop;

    await billing.settings.set('theme', 'dark');
    await billing.settings.set('a/b', 1);
    expect(await research.settings.get('theme')).toBeUndefined();
    expect(await research.settings.keys()).toEqual([]);
    expect(await otherBilling.settings.get('theme')).toBe('dark');
    expect((await billing.settings.keys()).sort()).toEqual(['a/b', 'theme']);
    await billing.settings.delete('theme');
    expect(await otherBilling.settings.get('theme')).toBeUndefined();
  });

  it('cannot reach another app by naming its key', async () => {
    const { mount, store } = await setup();
    await (await mount('billing')).braidDesktop.settings.set('../research/theme', 'x');
    expect(await store.list('apps/research/')).toEqual([]);
  });
});

describe('layouts', () => {
  it('saves the container in order — app, src, props, channel, state — and restores it', async () => {
    const { workspace, container, place } = await setup();
    const billing = await place('billing', { src: '/billing/42', props: '{"compact":true}' });
    const research = await place('research');
    await billing.fdc3.joinUserChannel('fdc3.channel.2');
    billing.braidDesktop.onSaveLayout(() => ({ tab: 'overdue' }));
    research.braidDesktop.onSaveLayout(() => () => 'not json');

    const saved = await workspace.layouts.save('morning');
    expect(saved.slots).toEqual([
      { appId: 'billing', src: '/billing/42', props: { compact: true }, channel: 'fdc3.channel.2', state: { tab: 'overdue' } },
      { appId: 'research' },
    ]);
    expect(await workspace.layouts.list()).toEqual(['morning']);

    // a different page: one unrelated slot, then the restore replaces it
    for (const slot of [...container.children]) slot.remove();
    await place('blotter');
    await workspace.layouts.restore('morning');

    expect(container.children.map((slot) => slot.getAttribute('name'))).toEqual(['billing', 'research']);
    const [restoredBilling, restoredResearch] = await Promise.all(container.children.map((slot) => slot.booted));
    expect(container.children[0].getAttribute('src')).toBe('/billing/42');
    expect(container.children[0].props).toEqual({ compact: true });
    expect((await restoredBilling.fdc3!.getCurrentChannel())?.id).toBe('fdc3.channel.2');
    expect(restoredBilling.braidDesktop.restoredState).toEqual({ tab: 'overdue' });
    expect(restoredResearch.braidDesktop.restoredState).toBeUndefined();

    await workspace.layouts.delete('morning');
    expect(await workspace.layouts.list()).toEqual([]);
    await expect(workspace.layouts.restore('morning')).rejects.toThrow('no saved layout');
  });

  it('keeps any layout name, and restores slots for apps outside the directory without FDC3', async () => {
    const { workspace, container, store } = await setup();
    await store.set('layouts/old', { version: 1, savedAt: '', slots: [{ appId: 'plain-widget', state: 1 }, { appId: 'billing' }] });
    await workspace.layouts.restore('old');
    expect(container.children.map((slot) => slot.getAttribute('name'))).toEqual(['plain-widget', 'billing']);
    // a plain fragment still gets its state back; only an app the directory has gets FDC3
    const plain = await container.children[0].booted;
    expect(plain.fdc3).toBeUndefined();
    expect(plain.braidDesktop.restoredState).toBe(1);
    expect((await container.children[1].booted).fdc3).toBeDefined();

    await workspace.layouts.save("Jeff's desk / 2");
    expect(await workspace.layouts.list()).toContain("Jeff's desk / 2");
  });

  it('needs a container', async () => {
    const { workspace } = await setup({ withContainer: false });
    await expect(workspace.layouts.save('x')).rejects.toThrow('no workspace area');
    expect(() => workspace.open('billing')).toThrow('no workspace area');
  });

  it('hands an intent waiting on a slot to its replacement when a layout is restored', async () => {
    const { workspace, container, mount, store } = await setup();
    await store.set('layouts/r', { version: 1, savedAt: '', slots: [{ appId: 'research' }] });
    const blotter = (await mount('blotter')).fdc3;
    const raised = blotter.raiseIntent('ViewResearch', instrument);
    await vi.waitFor(() => expect(container.children).toHaveLength(1));
    await workspace.layouts.restore('r');
    const replacement = (await container.children[0].booted).fdc3!;
    const handled = vi.fn(async () => undefined);
    await replacement.addIntentListener('ViewResearch', handled);
    expect((await raised).source.appId).toBe('research');
    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(1));
  });
});

describe('placement, order and handing an app over', () => {
  const names = (container: { children: FakeSlot[] }) => container.children.map((slot) => slot.getAttribute('name'));

  it('saves and restores each app\'s span with the layout, and drops spans that are not whole and in range', async () => {
    const { workspace, container } = await setup({ fdc3: false });
    const chart = workspace.open('chart', { placement: { columns: 2, rows: 3 } });
    const notes = workspace.open('notes');
    expect(workspace.placementOf(chart)).toEqual({ columns: 2, rows: 3 });
    expect(chart.getAttribute('data-braid-columns')).toBe('2');
    workspace.place(notes, { rows: 2, columns: 0 });
    expect(workspace.placementOf(notes)).toEqual({ rows: 2 });
    await Promise.all(container.children.map((slot) => slot.booted));

    expect((await workspace.layouts.save('wide')).slots).toEqual([
      { appId: 'chart', placement: { columns: 2, rows: 3 } },
      { appId: 'notes', placement: { rows: 2 } },
    ]);
    workspace.place(chart, {});
    expect(workspace.placementOf(chart)).toEqual({});
    expect(chart.getAttribute('data-braid-columns')).toBeNull();

    await workspace.layouts.restore('wide');
    expect(container.children.map((slot) => workspace.placementOf(slot as unknown as Element))).toEqual([{ columns: 2, rows: 3 }, { rows: 2 }]);
  });

  it('restores a layout saved before placements, and ignores one a store mangled', async () => {
    const store = memoryStore();
    await store.set('layouts/old', { version: 1, savedAt: '2026-11-01T00:00:00Z', slots: [{ appId: 'chart' }, { appId: 'notes', placement: { columns: 'wide', rows: 99 } }] });
    const { workspace, container } = await setup({ fdc3: false, store });
    await workspace.layouts.restore('old');
    expect(names(container)).toEqual(['chart', 'notes']);
    expect(container.children.map((slot) => workspace.placementOf(slot as unknown as Element))).toEqual([{}, {}]);
  });

  it('moves an app without stopping it, and the next save keeps the new order', async () => {
    const { workspace, container } = await setup({ fdc3: false });
    for (const id of ['a', 'b', 'c']) workspace.open(id);
    const booted = await Promise.all(container.children.map((slot) => slot.booted));
    booted[0].braidDesktop.onSaveLayout(() => ({ kept: true }));
    const [a] = container.children;

    workspace.move(a as unknown as Element, 2);
    expect(names(container)).toEqual(['b', 'c', 'a']);
    expect(a.controller.signal.aborted).toBe(false);
    workspace.move(a as unknown as Element, -5);
    expect(names(container)).toEqual(['a', 'b', 'c']);
    workspace.move(container.children[2] as unknown as Element, 1);
    expect(names(container)).toEqual(['a', 'c', 'b']);
    expect((await workspace.layouts.save('order')).slots.map((slot) => slot.appId)).toEqual(['a', 'c', 'b']);
    expect((await workspace.layouts.save('order')).slots[0].state).toEqual({ kept: true });

    const stranger = container.ownerDocument.createElement('fragment-slot') as unknown as Element;
    expect(() => workspace.move(stranger, 0)).toThrow(/in the workspace area/);
  });

  it('snapshots one app, and opens it elsewhere with that state and span', async () => {
    const { workspace, container } = await setup({ fdc3: false });
    const chart = workspace.open('chart', { props: { symbol: 'AAPL' }, placement: { columns: 3 } });
    const [booted] = await Promise.all(container.children.map((slot) => slot.booted));
    booted.braidDesktop.onSaveLayout(() => ({ zoom: 2 }));

    const snapshot = await workspace.snapshot(chart);
    expect(snapshot).toEqual({ appId: 'chart', props: { symbol: 'AAPL' }, state: { zoom: 2 }, placement: { columns: 3 } });
    expect(names(container)).toEqual(['chart']);

    // another page's workspace, given the snapshot
    const other = await setup({ fdc3: false });
    const { appId, ...rest } = snapshot;
    other.workspace.open(appId, rest);
    const [reopened] = await Promise.all(other.container.children.map((slot) => slot.booted));
    expect(reopened.braidDesktop.restoredState).toEqual({ zoom: 2 });
    expect(other.workspace.placementOf(other.container.children[0] as unknown as Element)).toEqual({ columns: 3 });
    expect(other.container.children[0].props).toEqual({ symbol: 'AAPL' });
  });

  it('snapshots an app still booting with the state it was opened with, and leaves a slot in place where it is', async () => {
    const { workspace, container } = await setup({ fdc3: false });
    const chart = workspace.open('chart', { state: { zoom: 3 }, channel: 'fdc3.channel.2' });
    // asked before the fragment has booted: nothing to ask it yet, so what it was given
    expect(await workspace.snapshot(chart)).toEqual({ appId: 'chart', state: { zoom: 3 }, channel: 'fdc3.channel.2' });

    let moves = 0;
    const insertBefore = container.insertBefore.bind(container);
    container.insertBefore = (slot, before) => (moves++, insertBefore(slot, before));
    workspace.open('notes');
    workspace.move(chart, 0);
    workspace.move(chart, -3);
    expect(moves).toBe(0);
    workspace.move(chart, 1);
    expect(moves).toBe(1);

    // a state that is not JSON is no state, rather than an error
    expect(() => workspace.open('odd', { state: () => 1 })).not.toThrow();
  });
});

describe('without an FDC3 agent', () => {
  it('gives every fragment its settings, and no fdc3', async () => {
    const { mount } = await setup({ fdc3: false });
    const billing = await mount('billing');
    expect(billing.fdc3).toBeUndefined();
    await billing.braidDesktop.settings.set('theme', 'dark');
    expect(await (await mount('billing')).braidDesktop.settings.get('theme')).toBe('dark');
    expect(await (await mount('research')).braidDesktop.settings.get('theme')).toBeUndefined();
  });

  it('opens apps in the area, then saves and restores them with their state', async () => {
    const { workspace, container } = await setup({ fdc3: false });
    await workspace.preferences.setHost({ defaultUserChannel: 'fdc3.channel.3' });
    workspace.open('billing', { src: '/billing/42', props: { compact: true } });
    workspace.open('notes');
    expect(container.children.map((slot) => slot.getAttribute('name'))).toEqual(['billing', 'notes']);
    const [billing, notes] = await Promise.all(container.children.map((slot) => slot.booted));
    billing.braidDesktop.onSaveLayout(() => ({ tab: 'overdue' }));
    const forget = notes.braidDesktop.onSaveLayout(() => 'draft');
    forget();

    expect((await workspace.layouts.save('desk')).slots).toEqual([
      { appId: 'billing', src: '/billing/42', props: { compact: true }, state: { tab: 'overdue' } },
      { appId: 'notes' },
    ]);
    workspace.open('extra');
    await workspace.layouts.restore('desk');
    expect(container.children.map((slot) => slot.getAttribute('name'))).toEqual(['billing', 'notes']);
    const [restored] = await Promise.all(container.children.map((slot) => slot.booted));
    expect(restored.braidDesktop.restoredState).toEqual({ tab: 'overdue' });
    expect(container.children[0].props).toEqual({ compact: true });
  });

  it('boots a fragment with its braidDesktop when the wrapped hook fails', async () => {
    const workspace = createWorkspace({ store: memoryStore(), container: null });
    const hook = workspace.realmGlobals(async () => {
      throw new Error('agent down');
    });
    const globals = (await hook({ fragmentId: 'billing', signal: new AbortController().signal })) as Globals;
    expect(globals.braidDesktop.restoredState).toBeUndefined();
  });

  it('cancels a raise with several candidates when there is no resolver to ask', async () => {
    const workspace = createWorkspace({ store: memoryStore(), container: null });
    const resolve = workspace.intentResolver();
    const candidates = [
      { intent: 'ViewInvoice', appId: 'billing' },
      { intent: 'ViewInvoice', appId: 'research' },
    ];
    expect(await resolve({ candidates })).toBeUndefined();
    expect(await resolve({ candidates: candidates.slice(0, 1) })).toEqual({ candidate: candidates[0] });
  });

  it('wires an agent to an area a framework renders later: refused until it is there, launched into once it is', async () => {
    const container = fakeContainer(() => realmGlobals);
    let rendered: Element | null = null;
    // `container` as a getter, standing in for the page's [data-braid-workspace] lookup
    const workspace = createWorkspace({
      store: memoryStore(),
      get container() {
        return rendered;
      },
    });
    const agent = createBraidDesktopAgent({ directory: await registryDirectory(), ...workspace.fdc3(), resolveIntent: false });
    const realmGlobals = workspace.realmGlobals(agent.realmGlobals);
    const controller = new AbortController();
    teardown.push(controller);
    const blotter = ((await realmGlobals({ fragmentId: 'blotter', signal: controller.signal })) as Globals).fdc3!;

    await expect(blotter.open({ appId: 'billing' })).rejects.toThrow('ErrorOnLaunch');
    rendered = container as unknown as Element;
    expect((await blotter.open({ appId: 'billing' })).appId).toBe('billing');
    expect(container.children.map((slot) => slot.getAttribute('name'))).toEqual(['billing']);
  });
});
