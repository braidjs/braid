import { describe, expect, it, vi } from 'vitest';
import type { RealmHandle } from '../realm/realm-manager.js';
import type { FragmentEnv } from '../env/fragment-env.js';

/**
 * The order the compat adapter boots in is the whole feature: accessors installed after the
 * fragment's scripts run would let `var dataLayer = dataLayer || []` make its own array. jsdom
 * cannot run the full realm patches, so this pins the order at the adapter seam; the accessors
 * themselves are exercised against a real realm in shared-globals.spec.ts.
 */
const calls: string[] = [];
vi.mock('../compat/realm-patches.js', () => ({
  initializeRealmContext: vi.fn((...args: unknown[]) => {
    calls.push(`realm-context:${JSON.stringify(args[5])}`);
    return { bootComplete: () => calls.push('boot-complete') };
  }),
}));
vi.mock('../compat/script-execution.js', () => ({
  executeScriptsInFragmentContent: vi.fn(() =>
    calls.push(`scripts${'fdc3' in window ? ':fdc3-defined' : ''}`),
  ),
}));

const { compatAdapter } = await import('./compat-adapter.js');

describe('compat adapter and shared globals', () => {
  async function boot(sharedGlobals?: readonly string[], realmGlobals?: Record<string, unknown>) {
    calls.length = 0;
    const slot = document.createElement('fragment-slot');
    const shadowRoot = slot.attachShadow({ mode: 'open' });
    const contentRoot = document.createElement('braid-html');
    shadowRoot.append(contentRoot);

    await compatAdapter.boot({
      fragmentId: 'cart',
      shadowRoot,
      contentRoot,
      realm: { fragmentId: 'cart', window } as unknown as RealmHandle,
      html: null,
      pierced: true,
      routeUrl: '/cart',
      bound: false,
      env: {} as FragmentEnv,
      ...(sharedGlobals === undefined ? {} : { sharedGlobals }),
      ...(realmGlobals === undefined ? {} : { realmGlobals }),
      signal: new AbortController().signal,
    });
  }

  it("hands the realm its shared globals before any of the fragment's scripts run", async () => {
    await boot(['dataLayer', '_satellite']);
    expect(calls).toEqual(['realm-context:["dataLayer","_satellite"]', 'scripts', 'boot-complete']);
  });

  it('shares nothing when the slot passes no list', async () => {
    await boot();
    expect(calls[0]).toBe('realm-context:[]');
  });

  it("defines the host's realm globals on the realm window after its patches and before any script runs", async () => {
    const agent = { getInfo: () => undefined };
    try {
      await boot([], { fdc3: agent });
      expect(calls).toEqual(['realm-context:[]', 'scripts:fdc3-defined', 'boot-complete']);
      expect((window as unknown as { fdc3: unknown }).fdc3).toBe(agent);
    } finally {
      delete (window as unknown as { fdc3?: unknown }).fdc3;
    }
  });
});
