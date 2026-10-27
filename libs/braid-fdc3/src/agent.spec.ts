import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@finos/fdc3-context';
import type { DesktopAgent } from '@finos/fdc3-standard';
import type { FragmentManifest } from '@braidlabs/gateway';
import { createRegistryApi, createSnapshot, memorySnapshotStore } from '@braidlabs/registry';
import { DefaultFDC3Server } from '@finos/fdc3-web-impl';
import { createBraidDesktopAgent } from './agent.js';

const instrument: Context = { type: 'fdc3.instrument', id: { ticker: 'AAPL' } };

const manifests: FragmentManifest[] = [
  {
    id: 'billing',
    endpoint: 'https://billing.internal',
    title: 'Billing',
    fdc3: { listensFor: { ViewInvoice: { contexts: ['fdc3.instrument'], resultType: 'fdc3.invoice' } } },
  },
  { id: 'blotter', endpoint: 'https://blotter.internal', title: 'Blotter' },
  {
    id: 'chart',
    endpoint: 'https://chart.internal',
    title: 'Chart',
    fdc3: { listensFor: { RefreshChart: { contexts: ['fdc3.nothing'] } } },
  },
  {
    id: 'research',
    endpoint: 'https://research.internal',
    title: 'Research',
    fdc3: { listensFor: { ViewResearch: { contexts: ['fdc3.instrument'] } } },
  },
];

/** The directory as a desktop agent would get it: from the registry's App Directory. */
async function registryDirectory() {
  const snapshot = await createSnapshot({ manifests });
  const store = memorySnapshotStore([snapshot]);
  await store.setHead?.(snapshot.id);
  const api = createRegistryApi({ store, appd: { origin: 'https://portal.example' } });
  const response = await api.handle(new Request('https://ops.example/__braid/registry-api/appd/v2/apps'));
  return (await response!.json()).applications;
}

const teardown: AbortController[] = [];
afterEach(() => teardown.splice(0).forEach((controller) => controller.abort()));

async function setup() {
  const agent = createBraidDesktopAgent({ directory: await registryDirectory() });
  /** Boots a fragment the way `<fragment-slot>` does: its id, and a signal for its teardown. */
  const mount = async (fragmentId: string) => {
    const controller = new AbortController();
    teardown.push(controller);
    const globals = await agent.realmGlobals({ fragmentId, signal: controller.signal });
    return { fdc3: globals?.fdc3 as DesktopAgent, unmount: () => controller.abort(), globals };
  };
  return { agent, mount };
}

/** Lets the in-process transport deliver whatever is in flight. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('a Braid page as an FDC3 desktop', () => {
  it("gives each fragment an fdc3 bound to its own registry id", async () => {
    const { mount } = await setup();
    const { fdc3 } = await mount('billing');

    const info = await fdc3.getInfo();
    expect(info.fdc3Version).toBe('3.0');
    expect(info.provider).toBe('Braid');
    expect(info.appMetadata.appId).toBe('billing');
    expect(info.appMetadata.instanceId).toEqual(expect.any(String));

    const other = (await mount('billing')).fdc3;
    expect((await other.getInfo()).appMetadata.instanceId).not.toBe(info.appMetadata.instanceId);
  });

  it('gives a fragment with no directory record nothing', async () => {
    const { mount } = await setup();

    expect((await mount('unlisted')).globals).toBeUndefined();
  });

  it('carries a broadcast from one fragment to another on the same user channel', async () => {
    const { mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const chart = (await mount('chart')).fdc3;

    expect(await chart.getUserChannels()).toHaveLength(8);
    const received = vi.fn();
    const own = vi.fn();
    await chart.joinUserChannel('fdc3.channel.1');
    await chart.addContextListener('fdc3.instrument', received);
    await blotter.joinUserChannel('fdc3.channel.1');
    await blotter.addContextListener('fdc3.instrument', own);

    await blotter.broadcast(instrument);
    await settle();

    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0][0]).toEqual(instrument);
    expect(received.mock.calls[0][1]?.source?.appId).toBe('blotter');
    // FDC3: a broadcaster does not hear itself
    expect(own).not.toHaveBeenCalled();

    // and not across channels
    await chart.joinUserChannel('fdc3.channel.2');
    await blotter.broadcast(instrument);
    await settle();
    expect(received).toHaveBeenCalledTimes(1);
  });

  it('carries an app channel between fragments', async () => {
    const { mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const chart = (await mount('chart')).fdc3;
    const received = vi.fn();

    await (await chart.getOrCreateChannel('pricing')).addContextListener(null, received);
    const pricing = await blotter.getOrCreateChannel('pricing');
    await pricing.broadcast(instrument);
    await settle();

    expect(received).toHaveBeenCalledWith(instrument, expect.anything());
    expect(await pricing.getCurrentContext()).toEqual(instrument);
  });

  it('resolves an intent to the live fragment that listens for it, and returns its result', async () => {
    const { mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const billing = (await mount('billing')).fdc3;
    const handled = vi.fn(async () => ({ type: 'fdc3.invoice', id: { invoice: 'INV-1' } }));
    await billing.addIntentListener('ViewInvoice', handled);

    const found = await blotter.findIntent('ViewInvoice', instrument);
    expect(found.apps.map((app) => app.appId)).toContain('billing');

    const resolution = await blotter.raiseIntent('ViewInvoice', instrument);
    expect(resolution.source.appId).toBe('billing');
    expect(await resolution.getResult()).toEqual({ type: 'fdc3.invoice', id: { invoice: 'INV-1' } });
    expect(handled).toHaveBeenCalledWith(instrument, expect.anything());
  });

  it('refuses a raise that needs a choice, since there is no resolver UI yet', async () => {
    const { mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const first = vi.fn();
    const second = vi.fn();
    await (await mount('billing')).fdc3.addIntentListener('ViewInvoice', first);
    await (await mount('billing')).fdc3.addIntentListener('ViewInvoice', second);

    await expect(blotter.raiseIntent('ViewInvoice', instrument)).rejects.toThrow('UserCancelledResolution');
    // naming the instance is how a caller chooses without a resolver
    const target = (await blotter.findInstances({ appId: 'billing' }))[1];
    await blotter.raiseIntent('ViewInvoice', instrument, target);
    await settle();
    expect(first.mock.calls.length + second.mock.calls.length).toBe(1);
  });

  it('refuses an intent nobody declared, and one whose app has no live instance, with NoAppsFound', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { mount } = await setup();
      const blotter = (await mount('blotter')).fdc3;

      await expect(blotter.raiseIntent('StartCall', instrument)).rejects.toThrow('NoAppsFound');
      // research declares ViewResearch but is not mounted, and nothing can launch it yet
      await expect(blotter.raiseIntent('ViewResearch', instrument)).rejects.toThrow('NoAppsFound');
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('releases a fragment when it is torn down: no more deliveries, no longer an instance', async () => {
    const { mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const billing = await mount('billing');
    const handled = vi.fn();
    const heard = vi.fn();
    await billing.fdc3.addIntentListener('ViewInvoice', handled);
    await billing.fdc3.joinUserChannel('fdc3.channel.3');
    await billing.fdc3.addContextListener(null, heard);
    await blotter.joinUserChannel('fdc3.channel.3');

    expect(await blotter.findInstances({ appId: 'billing' })).toHaveLength(1);
    billing.unmount();

    expect(await blotter.findInstances({ appId: 'billing' })).toEqual([]);
    await blotter.broadcast(instrument);
    await expect(blotter.raiseIntent('ViewInvoice', instrument)).rejects.toThrow('NoAppsFound');
    await settle();
    expect(handled).not.toHaveBeenCalled();
    expect(heard).not.toHaveBeenCalled();
  });

  it('gives an already torn-down fragment nothing', async () => {
    const { agent } = await setup();
    const controller = new AbortController();
    controller.abort();

    expect(await agent.realmGlobals({ fragmentId: 'billing', signal: controller.signal })).toBeUndefined();
  });

  it('gives a fragment no path from its fdc3 to the agent, so it can only speak as itself', async () => {
    const { mount } = await setup();
    const { fdc3 } = await mount('blotter');

    // every object reachable through properties, Map and Set entries, and prototypes' own fields
    const seen = new Set<unknown>();
    const queue: unknown[] = [fdc3];
    while (queue.length > 0) {
      const value = queue.shift();
      if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) continue;
      seen.add(value);
      if (value instanceof Map || value instanceof Set) queue.push(...value.keys(), ...value.values());
      for (const key of Reflect.ownKeys(value as object)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && 'value' in descriptor) queue.push(descriptor.value);
      }
    }

    expect(seen.size).toBeGreaterThan(10);
    expect([...seen].some((value) => value instanceof DefaultFDC3Server)).toBe(false);
  });

  it('refuses a context that cannot be cloned at once, rather than timing out or throwing unhandled', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { mount } = await setup();
      const { fdc3 } = await mount('blotter');
      await fdc3.joinUserChannel('fdc3.channel.1');
      const started = Date.now();

      await expect(fdc3.broadcast({ type: 'fdc3.instrument', format: () => 'AAPL' } as unknown as Context)).rejects.toThrow(
        'MalformedContext',
      );
      expect(Date.now() - started).toBeLessThan(1_000);
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('answers a call made after teardown at once', async () => {
    const { mount } = await setup();
    const billing = await mount('billing');
    billing.unmount();
    const started = Date.now();

    await expect(billing.fdc3.getInfo()).rejects.toThrow('AgentDisconnected');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('gives nothing, promptly, to a fragment torn down while it connects', async () => {
    const { agent } = await setup();
    const controller = new AbortController();
    const started = Date.now();

    const pending = agent.realmGlobals({ fragmentId: 'billing', signal: controller.signal });
    controller.abort();

    expect(await pending).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('treats a directory that failed to load as empty', async () => {
    const agent = createBraidDesktopAgent({ directory: undefined as never });

    expect(await agent.realmGlobals({ fragmentId: 'billing', signal: new AbortController().signal })).toBeUndefined();
  });

  it('holds an intent for a mounted fragment until its listener arrives, rather than losing it', async () => {
    const { mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const billing = (await mount('billing')).fdc3;

    // billing is mounted, but its bundle has not added a listener yet
    const raised = blotter.raiseIntent('ViewInvoice', instrument);
    await settle();
    const handled = vi.fn(async () => ({ type: 'fdc3.invoice', id: { invoice: 'INV-2' } }));
    await billing.addIntentListener('ViewInvoice', handled);

    const resolution = await raised;
    await settle();
    expect(resolution.source.appId).toBe('billing');
    expect(handled).toHaveBeenCalledTimes(1);
    expect(await resolution.getResult()).toEqual({ type: 'fdc3.invoice', id: { invoice: 'INV-2' } });
  });

  it('resolves a raise that names only the app to its live instance', async () => {
    const { mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const billing = (await mount('billing')).fdc3;
    const handled = vi.fn();
    await billing.addIntentListener('ViewInvoice', handled);

    const resolution = await blotter.raiseIntent('ViewInvoice', instrument, { appId: 'billing' });
    await settle();

    expect(resolution.source.appId).toBe('billing');
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it('refuses fdc3.open at once, since nothing can be launched yet', async () => {
    const { mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const started = Date.now();

    await expect(blotter.open({ appId: 'billing' })).rejects.toThrow('ErrorOnLaunch');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('refuses fdc3.close at once, since a fragment is torn down by its host, and keeps working', async () => {
    const { mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const started = Date.now();

    await expect(blotter.close()).rejects.toThrow('ErrorOnClose');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect((await blotter.getInfo()).appMetadata.appId).toBe('blotter');
  });

  it.each([
    ['with no target', (fdc3: DesktopAgent) => fdc3.raiseIntent('ViewInvoice', instrument, undefined, true)],
    ['naming the app', (fdc3: DesktopAgent) => fdc3.raiseIntent('ViewInvoice', instrument, { appId: 'billing' }, true)],
    ['for a context', (fdc3: DesktopAgent) => fdc3.raiseIntentForContext(instrument, undefined, true)],
  ])('refuses a raise that asks for a new instance at once, %s, since nothing can be launched yet', async (_, raise) => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { mount } = await setup();
      const blotter = (await mount('blotter')).fdc3;
      const handled = vi.fn();
      await (await mount('billing')).fdc3.addIntentListener('ViewInvoice', handled);
      const started = Date.now();

      await expect(raise(blotter)).rejects.toThrow('TargetAppUnavailable');
      expect(Date.now() - started).toBeLessThan(1_000);
      await settle();
      // not quietly handed to the instance that is already running
      expect(handled).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('gives a raise that asks for an existing instance to the live one, and refuses it when there is none', async () => {
    const { mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const handled = vi.fn();
    await (await mount('billing')).fdc3.addIntentListener('ViewInvoice', handled);

    const resolution = await blotter.raiseIntent('ViewInvoice', instrument, { appId: 'billing' }, false);
    await settle();
    expect(resolution.source.appId).toBe('billing');
    expect(handled).toHaveBeenCalledTimes(1);

    // research declares ViewResearch but is not mounted
    const started = Date.now();
    await expect(blotter.raiseIntent('ViewResearch', instrument, { appId: 'research' }, false)).rejects.toThrow(
      'TargetInstanceUnavailable',
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('delivers a raise with no context as fdc3.nothing to a fragment that declares it', async () => {
    const { mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const handled = vi.fn();
    await (await mount('chart')).fdc3.addIntentListener('RefreshChart', handled);

    const resolution = await blotter.raiseIntent('RefreshChart');
    await settle();

    expect(resolution.source.appId).toBe('chart');
    expect(handled).toHaveBeenCalledWith({ type: 'fdc3.nothing' }, expect.anything());
  });

  it('carries FDC3 3.0 context metadata between fragments: trace ids, current context with metadata, clearing', async () => {
    const { mount } = await setup();
    const blotter = (await mount('blotter')).fdc3;
    const chart = (await mount('chart')).fdc3;
    const billing = (await mount('billing')).fdc3;
    const received = vi.fn();
    const cleared = vi.fn();
    const handled = vi.fn();
    await chart.joinUserChannel('fdc3.channel.3');
    await chart.addContextListener('fdc3.instrument', received);
    await chart.addEventListener('contextCleared', cleared);
    await billing.addIntentListener('ViewInvoice', handled);
    await blotter.joinUserChannel('fdc3.channel.3');

    await blotter.broadcast(instrument, { traceId: 'trace-broadcast' });
    await settle();
    expect(received.mock.calls[0][1]).toMatchObject({ traceId: 'trace-broadcast', source: { appId: 'blotter' } });
    const current = await (await chart.getCurrentChannel())!.getCurrentContextWithMetadata('fdc3.instrument');
    expect(current?.context).toEqual(instrument);
    expect(current?.metadata.traceId).toBe('trace-broadcast');

    await blotter.raiseIntent('ViewInvoice', instrument, undefined, undefined, { traceId: 'trace-raise' });
    await settle();
    expect(handled.mock.calls[0][1]).toMatchObject({ traceId: 'trace-raise', source: { appId: 'blotter' } });

    await (await blotter.getCurrentChannel())!.clearContext();
    await settle();
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(cleared.mock.calls[0][0].details.channelId).toBe('fdc3.channel.3');
    expect(await (await chart.getCurrentChannel())!.getCurrentContext()).toBeNull();
  });

  it('keeps delivering to the other listeners when one throws', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const originalReportError = (globalThis as { reportError?: unknown }).reportError;
    const errors: unknown[] = [];
    (globalThis as { reportError?: unknown }).reportError = (error: unknown) => errors.push(error);
    try {
      const { mount } = await setup();
      const blotter = (await mount('blotter')).fdc3;
      const chart = (await mount('chart')).fdc3;
      const second = vi.fn();
      await chart.joinUserChannel('fdc3.channel.4');
      await chart.addContextListener(null, () => {
        throw new Error('handler bug');
      });
      await chart.addContextListener(null, second);
      await blotter.joinUserChannel('fdc3.channel.4');

      await blotter.broadcast(instrument);
      await settle();

      expect(second).toHaveBeenCalledTimes(1);
      expect(errors).toHaveLength(1);
      // and the fragment's own requests still get their answers
      expect((await chart.getInfo()).appMetadata.appId).toBe('chart');
    } finally {
      (globalThis as { reportError?: unknown }).reportError = originalReportError;
      reported.mockRestore();
    }
  });
});
