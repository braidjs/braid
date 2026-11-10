import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@finos/fdc3-context';
import type { DesktopAgent } from '@finos/fdc3-standard';
import type { FragmentManifest } from '@braidlabs/gateway';
import { createRegistryApi, createSnapshot, memorySnapshotStore } from '@braidlabs/registry';
import { createBraidDesktopAgent, type BraidDesktopAgentOptions, type IntentResolverHook } from './agent.js';

/**
 * Launching and choosing, against a container that boots slots the way `<fragment-slot>` does:
 * each slot that connects asks the agent for its globals with its name, its signal and itself.
 * The real element is exercised in Chromium by e2e/workspace.e2e.ts.
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
  remove(): void;
  /** Resolves with what the agent gave the fragment once it has booted. */
  booted: Promise<{ fdc3: DesktopAgent } | undefined>;
  controller: AbortController;
}

type Agent = ReturnType<typeof createBraidDesktopAgent>;

/** A container whose slots boot against `agent()` when appended, as `<fragment-slot>` would. */
function fakeContainer(agent: () => Agent) {
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
    append(slot: FakeSlot) {
      children.push(slot);
      teardown.push(slot.controller);
      const props = slot.getAttribute('props');
      if (props) slot.props = JSON.parse(props);
      // a fragment boots after its slot connects, a task or more later
      setTimeout(async () => {
        const globals = await agent().realmGlobals({
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

async function setup(options: Partial<BraidDesktopAgentOptions> & { withContainer?: boolean } = {}) {
  // the container's slots boot later, against the agent created just below
  const container = fakeContainer(() => agent);
  const agent: Agent = createBraidDesktopAgent({
    directory: await registryDirectory(),
    resolveIntent: false,
    ...(options.withContainer === false ? {} : { container: container as unknown as Element }),
    ...options,
  });
  /** A fragment the host mounted itself, not in the container. */
  const mount = async (fragmentId: string) => {
    const controller = new AbortController();
    teardown.push(controller);
    const globals = await agent.realmGlobals({ fragmentId, signal: controller.signal });
    return { fdc3: globals!.fdc3, unmount: () => controller.abort() };
  };
  /** Mounts into the container, as the host's own markup would, and waits for the boot. */
  const place = async (fragmentId: string, attributes: Record<string, string> = {}) => {
    const slot = container.ownerDocument.createElement('fragment-slot');
    slot.setAttribute('name', fragmentId);
    for (const [name, value] of Object.entries(attributes)) slot.setAttribute(name, value);
    container.append(slot);
    return { slot, ...(await slot.booted)! };
  };
  return { agent, container, mount, place };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe('launching', () => {
  it('fdc3.open mounts a slot in the container, resolves with its identity, and delivers the context', async () => {
    const { container, mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;

    const opening = blotter.open({ appId: 'billing' }, instrument);
    await vi.waitFor(() => expect(container.children).toHaveLength(1));
    const slot = container.children[0];
    expect(slot.getAttribute('name')).toBe('billing');

    const billing = (await slot.booted)!.fdc3;
    const received = vi.fn();
    await billing.addContextListener('fdc3.instrument', received);
    const opened = await opening;

    expect(opened.appId).toBe('billing');
    expect((await billing.getInfo()).appMetadata.instanceId).toBe(opened.instanceId);
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(instrument, expect.anything()));
  });

  it('fdc3.open without a context resolves once the app has connected', async () => {
    const { mount } = await setup();
    const opened = await (await mount('blotter')).fdc3.open({ appId: 'billing' });
    expect(opened.appId).toBe('billing');
  });

  it('refuses to open an app the directory does not have with AppNotFound', async () => {
    const { container, mount } = await setup();
    await expect((await mount('blotter')).fdc3.open({ appId: 'nope' })).rejects.toThrow('AppNotFound');
    expect(container.children).toHaveLength(0);
  });

  it('still refuses fdc3.open with ErrorOnLaunch when there is no container', async () => {
    const { mount } = await setup({ withContainer: false });
    await expect((await mount('blotter')).fdc3.open({ appId: 'billing' })).rejects.toThrow('ErrorOnLaunch');
  });

  it('launches the app for an intent nothing running can take, and delivers it', async () => {
    const { container, mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;

    const raised = blotter.raiseIntent('ViewResearch', instrument);
    await vi.waitFor(() => expect(container.children).toHaveLength(1));
    const research = (await container.children[0].booted)!.fdc3;
    const handled = vi.fn(async () => undefined);
    await research.addIntentListener('ViewResearch', handled);

    expect((await raised).source.appId).toBe('research');
    await vi.waitFor(() => expect(handled).toHaveBeenCalledWith(instrument, expect.anything()));
  });

  it('launches a new instance for newInstance: true, even with one running and listening', async () => {
    const { container, mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const running = vi.fn(async () => undefined);
    await (await mount('research')).fdc3.addIntentListener('ViewResearch', running);

    const raised = blotter.raiseIntent('ViewResearch', instrument, { appId: 'research' }, true);
    await vi.waitFor(() => expect(container.children).toHaveLength(1));
    const fresh = (await container.children[0].booted)!.fdc3;
    const handled = vi.fn(async () => undefined);
    await fresh.addIntentListener('ViewResearch', handled);

    const resolution = await raised;
    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(1));
    expect(resolution.source.instanceId).toBe((await fresh.getInfo()).appMetadata.instanceId);
    expect(running).not.toHaveBeenCalled();
  });

  it('offers only launches for newInstance: true when several apps are running and listening', async () => {
    const resolveIntent = vi.fn<IntentResolverHook>(async ({ candidates }) => ({ candidate: candidates.find((c) => c.appId === 'research')! }));
    const { container, mount } = await setup({ resolveIntent });
    const blotter = (await mount('blotter')).fdc3;
    const running = vi.fn(async () => undefined);
    await (await mount('billing')).fdc3.addIntentListener('ViewInvoice', running);
    await (await mount('research')).fdc3.addIntentListener('ViewInvoice', running);

    const raised = blotter.raiseIntent('ViewInvoice', instrument, undefined, true);
    await vi.waitFor(() => expect(container.children).toHaveLength(1));
    const offered = resolveIntent.mock.calls[0][0].candidates.map((c) => [c.appId, c.instanceId !== undefined]);
    expect(offered.sort()).toEqual([
      ['billing', false],
      ['research', false],
    ]);
    expect(container.children[0].getAttribute('name')).toBe('research');
    const fresh = (await container.children[0].booted)!.fdc3;
    const handled = vi.fn(async () => undefined);
    await fresh.addIntentListener('ViewInvoice', handled);
    await raised;
    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(1));
    expect(running).not.toHaveBeenCalled();
  });

  it('launches an app named in a raise when it is not running', async () => {
    const { container, mount } = await setup();
    const raised = (await mount('blotter')).fdc3.raiseIntent('ViewInvoice', instrument, { appId: 'billing' });
    await vi.waitFor(() => expect(container.children).toHaveLength(1));
    const billing = (await container.children[0].booted)!.fdc3;
    const handled = vi.fn(async () => undefined);
    await billing.addIntentListener('ViewInvoice', handled);
    expect((await raised).source.appId).toBe('billing');
    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(1));
  });

  it('launches for newInstance: true with no app named, too', async () => {
    const { container, mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    await (await mount('research')).fdc3.addIntentListener('ViewResearch', async () => undefined);

    const raised = blotter.raiseIntent('ViewResearch', instrument, undefined, true);
    await vi.waitFor(() => expect(container.children).toHaveLength(1));
    await (await container.children[0].booted)!.fdc3.addIntentListener('ViewResearch', async () => undefined);
    expect((await raised).source.appId).toBe('research');
  });

  it('still holds an intent for a mounted, booting fragment rather than launching another', async () => {
    const { container, mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const research = (await mount('research')).fdc3;

    const raised = blotter.raiseIntent('ViewResearch', instrument);
    await settle();
    const handled = vi.fn(async () => undefined);
    await research.addIntentListener('ViewResearch', handled);

    expect((await raised).source.appId).toBe('research');
    expect(container.children).toHaveLength(0);
    expect(handled).toHaveBeenCalledTimes(1);
  });
});

describe('launching, under the races review found', () => {
  const microtasks = async (count: number) => {
    for (let index = 0; index < count; index++) await Promise.resolve();
  };

  it('an fdc3.open right after a raise that went to the resolver still launches', async () => {
    for (const gap of [0, 2, 10, 30]) {
      const { container, mount } = await setup({ resolveIntent: async () => undefined });
      const blotter = (await mount('blotter')).fdc3;
      await mount('research'); // booting: mounted, not listening
      await (await mount('billing')).fdc3.addIntentListener('ViewInvoice', async () => undefined);

      const raised = blotter.raiseIntent('ViewInvoice', instrument).catch((error: Error) => error.message);
      await microtasks(gap);
      const opening = blotter.open({ appId: 'research' });
      await vi.waitFor(() => expect(container.children).toHaveLength(1));
      await container.children[0].booted;
      expect((await opening).appId, `gap ${gap}`).toBe('research');
      expect(await raised).toBe('UserCancelledResolution');
      teardown.splice(0).forEach((controller) => controller.abort());
    }
  });

  it('two raises for an app that is not running mount it once, and both reach it', async () => {
    const { container, mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const first = blotter.raiseIntent('ViewResearch', instrument);
    const second = blotter.raiseIntent('ViewResearch', instrument);
    await vi.waitFor(() => expect(container.children).toHaveLength(1));
    const research = (await container.children[0].booted)!.fdc3;
    const handled = vi.fn(async () => undefined);
    await research.addIntentListener('ViewResearch', handled);

    await Promise.all([first, second]);
    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(2));
    await settle();
    expect(container.children).toHaveLength(1);
  });

  it('a raise while a host-placed slot is still loading waits for it rather than launching another', async () => {
    const { container, mount, place } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const placing = place('research');
    const raised = blotter.raiseIntent('ViewResearch', instrument);
    const { fdc3: research } = await placing;
    const handled = vi.fn(async () => undefined);
    await research.addIntentListener('ViewResearch', handled);

    expect((await raised).source.appId).toBe('research');
    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(1));
    expect(container.children.map((slot) => slot.getAttribute('name'))).toEqual(['research']);
  });

  it('two newInstance raises launch two instances, and each takes its own intent', async () => {
    const { container, mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const one = blotter.raiseIntent('ViewResearch', { ...instrument, id: { ticker: 'ONE' } }, { appId: 'research' }, true);
    const two = blotter.raiseIntent('ViewResearch', { ...instrument, id: { ticker: 'TWO' } }, { appId: 'research' }, true);
    await vi.waitFor(() => expect(container.children).toHaveLength(2));
    const received: string[][] = [[], []];
    const instances = await Promise.all(container.children.map((slot) => slot.booted));
    await Promise.all(
      instances.map((globals, index) =>
        globals!.fdc3.addIntentListener('ViewResearch', async (context) => void received[index].push(String(context.id?.ticker))),
      ),
    );
    const ids = await Promise.all(instances.map(async (globals) => (await globals!.fdc3.getInfo()).appMetadata.instanceId));
    const sources = [(await one).source.instanceId, (await two).source.instanceId];
    await vi.waitFor(() => expect(received.flat()).toHaveLength(2));
    expect(received.map((tickers) => tickers.length)).toEqual([1, 1]);
    expect(new Set(sources)).toEqual(new Set(ids));
  });

  it('a newInstance raise goes to the instance launched for it, not one that starts listening first', async () => {
    const { container, mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const old = (await mount('research')).fdc3; // connected, not yet listening
    const raised = blotter.raiseIntent('ViewResearch', instrument, { appId: 'research' }, true);
    await vi.waitFor(() => expect(container.children).toHaveLength(1));
    const oldHandler = vi.fn(async () => undefined);
    await old.addIntentListener('ViewResearch', oldHandler);
    const fresh = (await container.children[0].booted)!.fdc3;
    const freshHandler = vi.fn(async () => undefined);
    await fresh.addIntentListener('ViewResearch', freshHandler);

    expect((await raised).source.instanceId).toBe((await fresh.getInfo()).appMetadata.instanceId);
    await vi.waitFor(() => expect(freshHandler).toHaveBeenCalledTimes(1));
    expect(oldHandler).not.toHaveBeenCalled();
  });

  it('refuses a malformed or unknown fdc3.open without mounting anything', async () => {
    const { container, mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    for (const app of ['billing', { appId: 7 }, {}, { appId: ['billing'] }, { appId: 'not-in-directory' }]) {
      await expect(blotter.open(app as never), JSON.stringify(app)).rejects.toThrow('AppNotFound');
    }
    await settle();
    expect(container.children).toHaveLength(0);
  });

  it('delivers both a plain raise and a newInstance raise made together', async () => {
    const { container, mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const running = vi.fn(async () => undefined);
    await (await mount('research')).fdc3.addIntentListener('ViewResearch', running);

    const fresh = blotter.raiseIntent('ViewResearch', instrument, { appId: 'research' }, true);
    const plain = blotter.raiseIntent('ViewResearch', instrument);
    await vi.waitFor(() => expect(container.children.length).toBeGreaterThanOrEqual(1));
    const launched = vi.fn(async () => undefined);
    for (const slot of container.children) await (await slot.booted)!.fdc3.addIntentListener('ViewResearch', launched);
    await Promise.all([fresh, plain]);
    await vi.waitFor(() => expect(running.mock.calls.length + launched.mock.calls.length).toBe(2));
    expect(launched.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('hands an intent waiting on a slot that is removed to the slot that replaces it', async () => {
    const { container, mount, place } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const raised = blotter.raiseIntent('ViewResearch', instrument);
    await vi.waitFor(() => expect(container.children).toHaveLength(1));
    container.children[0].remove(); // before it connected
    const { fdc3: replacement } = await place('research');
    const handled = vi.fn(async () => undefined);
    await replacement.addIntentListener('ViewResearch', handled);
    expect((await raised).source.appId).toBe('research');
    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(1));
  });

  it('tells the resolver which apps are starting rather than to be launched', async () => {
    const resolveIntent = vi.fn<IntentResolverHook>(async () => undefined);
    const { mount } = await setup({ resolveIntent });
    const blotter = (await mount('blotter')).fdc3;
    await mount('research'); // connected, not listening
    await (await mount('billing')).fdc3.addIntentListener('ViewInvoice', async () => undefined);
    await blotter.raiseIntent('ViewInvoice', instrument).catch(() => undefined);
    const offered = resolveIntent.mock.calls[0][0].candidates.map((c) => [c.appId, c.instanceId !== undefined, c.starting === true]);
    expect(offered.sort()).toEqual([
      ['billing', true, false],
      ['research', false, true],
    ]);
  });
});

describe('resolving intents', () => {
  async function twoListeners(options: Partial<BraidDesktopAgentOptions> = {}) {
    const ctx = await setup({ withContainer: false, ...options });
    const blotter = (await ctx.mount('blotter')).fdc3;
    const billing = vi.fn(async () => undefined);
    const research = vi.fn(async () => undefined);
    await (await ctx.mount('billing')).fdc3.addIntentListener('ViewInvoice', billing);
    await (await ctx.mount('research')).fdc3.addIntentListener('ViewInvoice', research);
    return { ...ctx, blotter, billing, research };
  }

  it('asks the resolver when more than one app can take the intent, and routes to its choice', async () => {
    const resolveIntent = vi.fn(async ({ candidates }) => ({ candidate: candidates.find((c: { appId: string }) => c.appId === 'research')! }));
    const { blotter, billing, research } = await twoListeners({ resolveIntent });

    const resolution = await blotter.raiseIntent('ViewInvoice', instrument);
    await settle();

    expect(resolution.source.appId).toBe('research');
    expect(research).toHaveBeenCalledTimes(1);
    expect(billing).not.toHaveBeenCalled();
    const request = resolveIntent.mock.calls[0][0];
    expect(request.raisedBy.appId).toBe('blotter');
    expect(request.context).toEqual(instrument);
    expect(request.candidates.map((c: { appId: string; title: string }) => [c.appId, c.title]).sort()).toEqual([
      ['billing', 'Billing'],
      ['research', 'Research'],
    ]);
  });

  it('refuses with UserCancelledResolution when the resolver cancels, or picks something it was not offered', async () => {
    const { blotter } = await twoListeners({ resolveIntent: async () => undefined });
    await expect(blotter.raiseIntent('ViewInvoice', instrument)).rejects.toThrow('UserCancelledResolution');

    const rogue = await twoListeners({
      resolveIntent: async () => ({ candidate: { intent: 'ViewInvoice', appId: 'blotter', title: 'x' } }),
    });
    await expect(rogue.blotter.raiseIntent('ViewInvoice', instrument)).rejects.toThrow('UserCancelledResolution');
  });

  it('treats a resolver that throws as a cancel', async () => {
    const { blotter } = await twoListeners({
      resolveIntent: async () => {
        throw new Error('picker crashed');
      },
    });
    await expect(blotter.raiseIntent('ViewInvoice', instrument)).rejects.toThrow('UserCancelledResolution');
  });

  it('offers running instances and launchable apps together when there is a container', async () => {
    const resolveIntent = vi.fn<IntentResolverHook>(async () => undefined);
    const { mount } = await setup({ resolveIntent });
    const blotter = (await mount('blotter')).fdc3;
    await (await mount('billing')).fdc3.addIntentListener('ViewInvoice', async () => undefined);

    await expect(blotter.raiseIntent('ViewInvoice', instrument)).rejects.toThrow('UserCancelledResolution');
    const offered = resolveIntent.mock.calls[0][0].candidates.map((c: { appId: string; instanceId?: string }) => [c.appId, !!c.instanceId]);
    expect(offered).toEqual(expect.arrayContaining([['billing', true], ['research', false]]));
    // billing is already listening, so launching another is not offered
    expect(offered).toHaveLength(2);
  });
});
