import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { memoryPreferenceBackend } from '../libs/braid-gateway/src/index.js';
import { bundleModule, endpoint, html, launch, readySlots, startHost, type Host } from './harness.js';

/**
 * @braidlabs/fdc3's workspace in Chromium, through a real gateway: fdc3.open mounting a real
 * <fragment-slot>, the built-in resolver dialog driven by the keyboard, remembered choices, host
 * preferences, app settings and layouts — each surviving a reload, with the browser store and with
 * the gateway's per-user store.
 */

/**
 * Each fragment hands its fdc3 and braidDesktop to the page, so a test can act as that fragment,
 * and logs what it receives. `top` is the host window; the fragment runs in its own realm.
 */
const fragment = (appId: string, listens: boolean) =>
  html(`<p>${appId}</p><script>
    top.log = top.log || [];
    top.instances = top.instances || [];
    const me = top.instances.push({ appId: ${JSON.stringify(appId)}, fdc3, braidDesktop });
    fdc3.addContextListener('fdc3.instrument', (context) => top.log.push('${appId}:context:' + context.id.ticker));
    ${listens ? `fdc3.addIntentListener('ViewInvoice', (context) => { top.log.push('${appId}:intent:' + context.id.ticker, '${appId}#' + me + ':intent'); });` : ''}
    braidDesktop.onSaveLayout(() => ({ tab: top.tabs && top.tabs[${JSON.stringify(appId)}] }));
    if (braidDesktop.restoredState !== undefined) top.log.push('${appId}:restored:' + JSON.stringify(braidDesktop.restoredState));
  </script>`);

const backend = memoryPreferenceBackend();
let browser: Browser;
let host: Host;

beforeAll(async () => {
  browser = await launch();
  host = await startHost({
    gateway: {
      registry: [
        { id: 'blotter', endpoint: endpoint(() => fragment('blotter', false)) },
        {
          id: 'billing',
          title: 'Billing',
          endpoint: endpoint(() => fragment('billing', true)),
          fdc3: { listensFor: { ViewInvoice: { contexts: ['fdc3.instrument'] } } },
        },
        {
          id: 'research',
          title: 'Research',
          endpoint: endpoint(() => fragment('research', true)),
          fdc3: { listensFor: { ViewInvoice: { contexts: ['fdc3.instrument'] } } },
        },
      ],
      discovery: { appd: true },
      preferences: { backend },
      // the signed-in user is whoever the `user` cookie names
      principal: (request) => {
        const user = /(?:^|;\s*)user=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1];
        return user ? { subject: user } : undefined;
      },
    },
    modules: { '/fdc3.js': bundleModule('libs/braid-fdc3/src/index.ts') },
    head: `<script type="module">
      import { createBraidDesktopAgent, localStorageStore, serverStore } from '/fdc3.js';
      window.agentReady = (async () => {
        const response = await fetch('/__braid/registry/appd/v2/apps');
        const applications = response.ok ? (await response.json()).applications : [];
        const query = new URLSearchParams(location.search);
        const store = query.get('store') === 'server' ? serverStore() : localStorageStore();
        // ?resolver=hook: a host resolver that picks research, recording what it was asked
        window.resolverCalls = [];
        const resolveIntent = query.get('resolver') === 'hook'
          ? async (request) => {
              window.resolverCalls.push(request.candidates.map((c) => c.appId).sort());
              return { candidate: request.candidates.find((c) => c.appId === 'research') };
            }
          : undefined;
        // any resolver dialog that ever appears is counted
        window.dialogsSeen = 0;
        new MutationObserver((records) => {
          for (const record of records) for (const node of record.addedNodes) if (node.localName === 'braid-intent-resolver') window.dialogsSeen++;
        }).observe(document.body, { childList: true });
        return (window.agent = createBraidDesktopAgent({ directory: applications, container: document.getElementById('desk'), store, resolveIntent }));
      })();
    </script>`,
    braidSource: '{ realmGlobals: (fragment) => window.agentReady.then((agent) => agent.realmGlobals(fragment)) }',
    body: '<fragment-slot name="blotter"></fragment-slot><div id="desk"></div>',
  });
});
afterAll(async () => {
  await browser?.close();
  await host?.close();
});

type Win = Window & {
  log: string[];
  instances: { appId: string; fdc3: import('@finos/fdc3-standard').DesktopAgent; braidDesktop: import('../libs/braid-fdc3/src/index.js').BraidDesktopApi }[];
  agent: import('../libs/braid-fdc3/src/index.js').BraidDesktopAgent;
  agentReady: Promise<unknown>;
  tabs: Record<string, string>;
  resolverCalls: string[][];
  dialogsSeen: number;
};

async function signedIn(user: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'user', value: user, url: host.url }]);
  return context;
}

async function open(context: BrowserContext, store: 'local' | 'server', query = ''): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error('page error:', error.message));
  await page.goto(`${host.url}?store=${store}${query}`);
  await readySlots(page, 'blotter');
  await page.evaluate(() => (window as unknown as Win).agentReady);
  return page;
}

/** Mounts an app in the desk the way a host's own markup would, and waits for it to boot. */
async function place(page: Page, appId: string, attributes: Record<string, string> = {}) {
  const count = await page.locator(`#desk fragment-slot[name="${appId}"]`).count();
  await page.evaluate(
    ([id, extra]) => {
      const slot = document.createElement('fragment-slot');
      slot.setAttribute('name', id);
      for (const [name, value] of Object.entries(extra)) slot.setAttribute(name, value);
      document.getElementById('desk')!.append(slot);
    },
    [appId, attributes] as const,
  );
  await page.waitForFunction(
    ([id, before]) => (window as unknown as Win).instances?.filter((instance) => instance.appId === id).length > before,
    [appId, count] as const,
  );
}

const log = (page: Page) => page.evaluate(() => [...((window as unknown as Win).log ?? [])]);
const desk = (page: Page) => page.locator('#desk fragment-slot').evaluateAll((slots) => slots.map((slot) => slot.getAttribute('name')));

/** Raises ViewInvoice from the blotter; resolves with where it went, or the error it rejected with. */
function raise(page: Page, app?: { appId: string }, newInstance?: boolean) {
  return page.evaluate(
    async ([target, fresh]) => {
      const blotter = (window as unknown as Win).instances.find((instance) => instance.appId === 'blotter')!.fdc3;
      try {
        const resolution = await blotter.raiseIntent('ViewInvoice', { type: 'fdc3.instrument', id: { ticker: 'AAPL' } }, target ?? undefined, fresh ?? undefined);
        return resolution.source.appId;
      } catch (error) {
        return `error:${(error as Error).message}`;
      }
    },
    [app ?? null, newInstance ?? null] as const,
  );
}

const dialog = (page: Page) => page.locator('braid-intent-resolver dialog');

describe('fdc3.open', () => {
  it('mounts a real slot in the container, resolves with its identity, and delivers the context', async () => {
    const context = await signedIn('opener');
    const page = await open(context, 'local');

    const opened = await page.evaluate(async () => {
      const blotter = (window as unknown as Win).instances.find((instance) => instance.appId === 'blotter')!.fdc3;
      return blotter.open({ appId: 'billing' }, { type: 'fdc3.instrument', id: { ticker: 'MSFT' } });
    });

    expect(opened.appId).toBe('billing');
    expect(await desk(page)).toEqual(['billing']);
    await readySlots(page, 'billing');
    await expect.poll(() => log(page)).toContain('billing:context:MSFT');
    const notFound = await page.evaluate(async () => {
      const blotter = (window as unknown as Win).instances.find((instance) => instance.appId === 'blotter')!.fdc3;
      return blotter.open({ appId: 'nope' }).catch((error: Error) => error.message);
    });
    expect(notFound).toBe('AppNotFound');
    await context.close();
  });
});

describe('raising an intent', () => {
  it('launches an app nothing running can take it for, and delivers the intent once it listens', async () => {
    const context = await signedIn('launcher');
    const page = await open(context, 'local');
    await page.evaluate(() => (window as unknown as Win).agent.preferences.setHost({ hiddenApps: ['research'] }));

    expect(await raise(page)).toBe('billing');
    expect(await desk(page)).toEqual(['billing']);
    await expect.poll(() => log(page)).toContain('billing:intent:AAPL');
    await context.close();
  });

  it('launches an app named in the raise when it is not running', async () => {
    const context = await signedIn('named');
    const page = await open(context, 'local');
    expect(await raise(page, { appId: 'research' })).toBe('research');
    expect(await desk(page)).toEqual(['research']);
    await expect.poll(() => log(page)).toContain('research:intent:AAPL');
    await context.close();
  });

  it('newInstance: true with two apps running offers launches only, and the new instance takes it', async () => {
    const context = await signedIn('fresh');
    const page = await open(context, 'local');
    await place(page, 'billing'); // instance #2 (the blotter is #1)
    await place(page, 'research'); // #3

    const raised = raise(page, undefined, true);
    await dialog(page).waitFor({ state: 'visible' });
    const notes = await dialog(page).locator('ul button .note').allTextContents();
    expect(notes).toEqual(['new', 'new']);
    await dialog(page).locator('ul button', { hasText: 'Research' }).click();
    expect(await raised).toBe('research');
    expect(await desk(page)).toEqual(['billing', 'research', 'research']);
    await expect.poll(() => log(page)).toContain('research#4:intent');
    expect((await log(page)).filter((entry) => /#[23]:intent/.test(entry))).toEqual([]);
    await context.close();
  });

  it('two quick newInstance raises launch two instances, and each takes one', async () => {
    const context = await signedIn('fresh-twice');
    const page = await open(context, 'local');
    const results = await Promise.all([raise(page, { appId: 'research' }, true), raise(page, { appId: 'research' }, true)]);
    expect(results).toEqual(['research', 'research']);
    expect(await desk(page)).toEqual(['research', 'research']);
    await expect.poll(async () => (await log(page)).filter((entry) => /^research#\d+:intent$/.test(entry)).sort()).toEqual([
      'research#2:intent',
      'research#3:intent',
    ]);
    await context.close();
  });

  it('a resolveIntent hook replaces the dialog', async () => {
    const context = await signedIn('hook');
    const page = await open(context, 'local', '&resolver=hook');
    await place(page, 'billing');
    await place(page, 'research');

    expect(await raise(page)).toBe('research');
    await expect.poll(() => log(page)).toContain('research:intent:AAPL');
    expect(await page.evaluate(() => (window as unknown as Win).resolverCalls)).toEqual([['billing', 'research']]);
    expect(await page.evaluate(() => (window as unknown as Win).dialogsSeen)).toBe(0);
    await context.close();
  });
});

describe.each(['local', 'server'] as const)('with the %s store', (store) => {
  it('resolves by keyboard in the dialog, cancels on Escape, and remembers a choice across a reload', async () => {
    const context = await signedIn(`resolver-${store}`);
    const page = await open(context, store);
    await place(page, 'billing');
    await place(page, 'research');

    // Escape cancels
    const cancelled = raise(page);
    await dialog(page).waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    expect(await cancelled).toBe('error:UserCancelledResolution');
    await expect.poll(() => page.locator('braid-intent-resolver').count()).toBe(0);

    // choose by keyboard: the first choice has focus; Tab to the next, Enter picks it
    const chosen = raise(page);
    await dialog(page).waitFor({ state: 'visible' });
    const names = await dialog(page).locator('ul button').allTextContents();
    expect(names.map((name) => name.replace(/(open|new)$/, '').trim()).sort()).toEqual(['Billing', 'Research']);
    const focused = await page.evaluate(() => document.querySelector('braid-intent-resolver')!.shadowRoot!.activeElement?.textContent);
    expect(focused).toBe(names[0]);
    const target = names[1].startsWith('Research') ? 'research' : 'billing';
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    expect(await chosen).toBe(target);
    await expect.poll(() => log(page)).toContain(`${target}:intent:AAPL`);

    // remember the other one
    const other = target === 'research' ? 'billing' : 'research';
    const remembered = raise(page);
    await dialog(page).waitFor({ state: 'visible' });
    await dialog(page).getByLabel('Remember my choice').check();
    await dialog(page).locator('ul button', { hasText: other === 'billing' ? 'Billing' : 'Research' }).click();
    expect(await remembered).toBe(other);

    // after a reload, it goes straight there
    await page.reload();
    await readySlots(page, 'blotter');
    await page.evaluate(() => (window as unknown as Win).agentReady);
    await place(page, 'billing');
    await place(page, 'research');
    expect(await raise(page)).toBe(other);
    expect(await page.locator('braid-intent-resolver').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as Win).agent.preferences.intentChoice('ViewInvoice', 'fdc3.instrument'))).toBe(other);

    // forgotten, it asks again
    await page.evaluate(() => (window as unknown as Win).agent.preferences.forgetIntentChoice('ViewInvoice', 'fdc3.instrument'));
    const again = raise(page);
    await dialog(page).waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    expect(await again).toBe('error:UserCancelledResolution');
    await context.close();
  });

  it('applies host preferences: the default user channel, and hidden apps', async () => {
    const context = await signedIn(`host-${store}`);
    const page = await open(context, store);
    await page.evaluate(() => (window as unknown as Win).agent.preferences.setHost({ defaultUserChannel: 'fdc3.channel.4', hiddenApps: ['research'] }));
    await page.reload();
    await readySlots(page, 'blotter');
    await page.evaluate(() => (window as unknown as Win).agentReady);
    await place(page, 'billing');
    await place(page, 'research');

    const channels = await page.evaluate(() =>
      Promise.all((window as unknown as Win).instances.map(async (instance) => (await instance.fdc3.getCurrentChannel())?.id)),
    );
    expect(channels).toEqual(['fdc3.channel.4', 'fdc3.channel.4', 'fdc3.channel.4']);
    // research is hidden, so billing is the only choice and no dialog opens
    expect(await raise(page)).toBe('billing');
    expect(await page.locator('braid-intent-resolver').count()).toBe(0);
    await context.close();
  });

  it("keeps each app's settings apart, across a reload", async () => {
    const context = await signedIn(`settings-${store}`);
    const page = await open(context, store);
    await place(page, 'billing');
    await place(page, 'research');
    await page.evaluate(() => (window as unknown as Win).instances.find((instance) => instance.appId === 'billing')!.braidDesktop.settings.set('theme', 'dark'));
    const seenByResearch = await page.evaluate(() =>
      (window as unknown as Win).instances.find((instance) => instance.appId === 'research')!.braidDesktop.settings.get('theme'),
    );
    expect(seenByResearch).toBeUndefined();

    await page.reload();
    await readySlots(page, 'blotter');
    await place(page, 'billing');
    const afterReload = await page.evaluate(() =>
      (window as unknown as Win).instances.find((instance) => instance.appId === 'billing')!.braidDesktop.settings.get('theme'),
    );
    expect(afterReload).toBe('dark');
    await context.close();
  });

  it('saves the desk as a layout and restores it after a reload: slots, channels, app state', async () => {
    const context = await signedIn(`layout-${store}`);
    const page = await open(context, store);
    await place(page, 'billing', { src: '/billing/42', props: '{"compact":true}' });
    await place(page, 'research');
    await page.evaluate(async () => {
      const win = window as unknown as Win;
      win.tabs = { billing: 'overdue' };
      await win.instances.find((instance) => instance.appId === 'billing')!.fdc3.joinUserChannel('fdc3.channel.2');
      await win.agent.layouts.save('morning');
    });
    expect(await page.evaluate(() => (window as unknown as Win).agent.layouts.list())).toEqual(['morning']);

    await page.reload();
    await readySlots(page, 'blotter');
    await page.evaluate(() => (window as unknown as Win).agentReady);
    expect(await desk(page)).toEqual([]);
    await page.evaluate(() => (window as unknown as Win).agent.layouts.restore('morning'));
    expect(await desk(page)).toEqual(['billing', 'research']);
    const restoredSlot = await page.locator('#desk fragment-slot[name="billing"]').evaluate((slot) => [
      slot.getAttribute('src'),
      (slot as HTMLElement & { props: unknown }).props,
    ]);
    expect(restoredSlot).toEqual(['/billing/42', { compact: true }]);
    await readySlots(page, 'billing', 'research');
    await expect.poll(() => log(page)).toContain('billing:restored:{"tab":"overdue"}');
    const channels = await page.evaluate(() =>
      Promise.all(
        (window as unknown as Win).instances
          .filter((instance) => instance.appId !== 'blotter')
          .map(async (instance) => [instance.appId, (await instance.fdc3.getCurrentChannel())?.id ?? null]),
      ).then((pairs) => pairs.sort()),
    );
    expect(channels).toEqual([
      ['billing', 'fdc3.channel.2'],
      ['research', null],
    ]);

    if (store === 'server') {
      // it is on the gateway, for this user only
      expect(await backend.list(`layout-${store}`, 'layouts/')).toEqual(['layouts/morning']);
      const stranger = await signedIn('someone-else');
      const theirs = await open(stranger, 'server');
      expect(await theirs.evaluate(() => (window as unknown as Win).agent.layouts.list())).toEqual([]);
      await stranger.close();
    }

    await page.evaluate(() => (window as unknown as Win).agent.layouts.delete('morning'));
    await page.reload();
    await readySlots(page, 'blotter');
    await page.evaluate(() => (window as unknown as Win).agentReady);
    expect(await page.evaluate(() => (window as unknown as Win).agent.layouts.list())).toEqual([]);
    const missing = await page.evaluate(() => (window as unknown as Win).agent.layouts.restore('morning').catch((error: Error) => error.message));
    expect(missing).toContain('no saved layout');
    await context.close();
  });
});
