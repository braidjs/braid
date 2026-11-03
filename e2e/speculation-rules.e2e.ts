import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { endpoint, html, startHost, type Host } from './harness.js';

/**
 * Speculation Rules from the registry, in Chromium: a page that links to a fragment's route lets
 * the browser prerender that route — composed, realm booted — so following the link shows a page
 * that is already there.
 *
 * Driven over the DevTools protocol directly rather than through Playwright: Chromium refuses to
 * prerender (`PrerenderingDisabledByDevTools`) while a client auto-attaches to every new target,
 * which is how Playwright works.
 */

let host: Host;
let documentFetches = 0;

beforeAll(async () => {
  host = await startHost({
    gateway: {
      speculationRules: true,
      registry: [
        {
          id: 'billing',
          pierce: ['/billing'],
          speculate: 'prerender',
          endpoint: endpoint(() => {
            documentFetches++;
            return html('<h1 id="title">Billing</h1>');
          }),
        },
      ],
    },
    pages: ['/billing'],
    // one outlet: idle on the home page, filled by the gateway on /billing
    body: '<a id="go" href="/billing" style="display:inline-block;padding:20px">Billing</a><fragment-slot outlet></fragment-slot>',
  });
});

afterAll(async () => {
  await host?.close();
});

interface Cdp {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  waitFor(method: string, match?: (params: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Chromium with nothing attached but this one client. */
async function rawChromium(): Promise<Cdp> {
  const profile = mkdtempSync(join(tmpdir(), 'braid-prerender-'));
  const browser: ChildProcess = spawn(chromium.executablePath(), [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]);
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium did not start')), 15_000);
    browser.stderr?.on('data', (chunk: Buffer) => {
      const found = /ws:\/\/\S+/.exec(String(chunk));
      if (found) {
        clearTimeout(timer);
        resolve(found[0]);
      }
    });
  });
  const socket = new WebSocket(url);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));

  let nextId = 0;
  const pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  const listeners = new Set<(message: { method: string; params: Record<string, unknown> }) => void>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) pending.get(message.id)?.(message);
    else for (const listener of listeners) listener(message);
  });

  return {
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result as never)));
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
    waitFor: (method, match = () => true, timeoutMs = 10_000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error(`timed out waiting for ${method}`));
        }, timeoutMs);
        const listener = (message: { method: string; params: Record<string, unknown> }) => {
          if (message.method !== method || !match(message.params)) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(message.params);
        };
        listeners.add(listener);
      }),
    close: async () => {
      socket.close();
      const exited = new Promise((resolve) => browser.once('exit', resolve));
      browser.kill();
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

async function evaluate<T>(cdp: Cdp, sessionId: string, expression: string): Promise<T> {
  const { result } = await cdp.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  return result.value;
}

/** Attaches to the page at `url` once it is an ordinary page: a prerendered one carries a `prerender` subtype until activated. */
async function activatedPage(cdp: Cdp, url: (url: string) => boolean): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; subtype?: string; url: string }[] }>(
      'Target.getTargets',
    );
    const target = targetInfos.find((info) => info.type === 'page' && info.subtype !== 'prerender' && url(info.url));
    if (target) {
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      return sessionId;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the page was never activated');
}

describe('speculation rules', () => {
  it('prerender a fragment’s route from a page that links to it, so the click activates it', async () => {
    const cdp = await rawChromium();
    try {
      // through the tab, as DevTools does: a client attached to the page target alone could not
      // follow the prerendered page when it is swapped in, so Chromium would refuse to prerender
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets', {
        filter: [{ type: 'tab' }],
      });
      const tab = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: targetInfos[0].targetId, flatten: true });
      const attached = cdp.waitFor('Target.attachedToTarget', (params) => (params['targetInfo'] as { type: string }).type === 'page');
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, tab.sessionId);
      const home = (await attached)['sessionId'] as string;
      await cdp.send('Page.enable', {}, home);
      await cdp.send('Preload.enable', {}, home);

      const loaded = cdp.waitFor('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: host.url }, home);
      await loaded;

      // hovering the link is what `moderate` eagerness waits for
      const box = await evaluate<{ x: number; y: number }>(
        cdp,
        home,
        `(() => { const r = document.getElementById('go').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      const prerendered = cdp.waitFor('Preload.prerenderStatusUpdated', (params) => params['status'] === 'Ready');
      const prerenderTarget = cdp.waitFor(
        'Target.attachedToTarget',
        (params) => (params['targetInfo'] as { subtype?: string }).subtype === 'prerender',
      );
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }, home);
      await prerendered;

      // `Ready` means the document committed, not that the fragment booted: wait for the slot,
      // inside the page that is still being prerendered
      const hidden = (await prerenderTarget)['sessionId'] as string;
      let booted: { prerendering: boolean; state: string | null } | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        booted = await evaluate<{ prerendering: boolean; state: string | null }>(
          cdp,
          hidden,
          `({ prerendering: document.prerendering, state: document.querySelector('fragment-slot[name="billing"]')?.getAttribute('state') ?? null })`,
        );
        if (booted.state === 'ready' || booted.state === 'healthy' || booted.state === 'unobservable') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // a prerendered page is hidden, so a booted fragment's liveness reads `unobservable`
      expect(booted).toMatchObject({ prerendering: true, state: expect.stringMatching(/^(ready|healthy|unobservable)$/) });
      const fetchesWhenPrerendered = documentFetches;
      expect(fetchesWhenPrerendered).toBeGreaterThan(0);

      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }, home);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }, home);
      // activation: the prerendered page stops being one, and becomes the tab's page
      const billing = await activatedPage(cdp, (url) => url.endsWith('/billing'));
      const page = await evaluate<{ activationStart: number; state: string | null; title: string | null }>(
        cdp,
        billing,
        `(() => {
          const slot = document.querySelector('fragment-slot[name="billing"]');
          return {
            activationStart: performance.getEntriesByType('navigation')[0].activationStart,
            state: slot && slot.getAttribute('state'),
            title: slot && slot.shadowRoot && slot.shadowRoot.querySelector('#title') && slot.shadowRoot.querySelector('#title').textContent,
          };
        })()`,
      );
      expect(page.activationStart).toBeGreaterThan(0);
      expect(page.state).toMatch(/^(ready|healthy)$/);
      expect(page.title).toBe('Billing');
      expect(documentFetches).toBe(fetchesWhenPrerendered);
    } finally {
      await cdp.close();
    }
  }, 60_000);
});
