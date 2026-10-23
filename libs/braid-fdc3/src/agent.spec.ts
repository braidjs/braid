import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@finos/fdc3-context';
import type { DesktopAgent } from '@finos/fdc3-standard';
import type { FragmentManifest } from '@braidlabs/gateway';
import { createRegistryApi, createSnapshot, memorySnapshotStore } from '@braidlabs/registry';
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
  { id: 'chart', endpoint: 'https://chart.internal', title: 'Chart' },
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
    expect(info.fdc3Version).toBe('2.2');
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
});
