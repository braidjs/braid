import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRealmGlobals, installSharedGlobals, resolveRealmGlobals } from './shared-globals.js';
import { getBraidConfig, setBraidConfig } from '../config.js';

/**
 * Shared globals are checked against a real realm: a same-origin iframe running real classic
 * scripts. Bare-identifier resolution (`var dataLayer = dataLayer || []`) is the behaviour that
 * matters, and only the engine's global-binding rules can say whether it reaches the accessor.
 */
describe('installSharedGlobals()', () => {
  const host = window as unknown as Record<string, unknown>;
  const frames: HTMLIFrameElement[] = [];
  const hostNames = ['dataLayer', '_satellite', 'KAMPYLE'];

  afterEach(() => {
    frames.splice(0).forEach((frame) => frame.remove());
    for (const name of hostNames) delete host[name];
    setBraidConfig({ dev: false });
    vi.restoreAllMocks();
  });

  function createRealm(): Window & Record<string, unknown> {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    frames.push(frame);
    return frame.contentWindow as Window & Record<string, unknown>;
  }

  function run(realm: Window, source: string): void {
    const script = realm.document.createElement('script');
    script.textContent = source;
    realm.document.body.append(script);
  }

  it("routes a fragment's dataLayer pushes into the host's own array", () => {
    const hostDataLayer: unknown[] = [];
    host.dataLayer = hostDataLayer;
    const realm = createRealm();

    installSharedGlobals(realm, window, ['dataLayer'], 'cart');
    run(realm, `var dataLayer = dataLayer || []; dataLayer.push({ event: 'bare' }); window.dataLayer.push({ event: 'window' });`);

    expect(host.dataLayer).toBe(hostDataLayer);
    expect(hostDataLayer).toEqual([{ event: 'bare' }, { event: 'window' }]);
  });

  it('reads the host live, so a global the host sets up after boot is still seen', () => {
    const realm = createRealm();
    installSharedGlobals(realm, window, ['_satellite'], 'cart');

    expect(realm._satellite).toBeUndefined();
    const satellite = { track: vi.fn() };
    host._satellite = satellite;

    run(realm, `_satellite.track('cart:view');`);
    expect(realm._satellite).toBe(satellite);
    expect(satellite.track).toHaveBeenCalledWith('cart:view');
  });

  it('writes the host, so a fragment that initializes a shared global initializes it for everyone', () => {
    const realm = createRealm();
    installSharedGlobals(realm, window, ['KAMPYLE'], 'cart');

    run(realm, `KAMPYLE = { ready: true };`);
    expect(host.KAMPYLE).toEqual({ ready: true });
  });

  it('skips a name the realm already has, leaving the realm its own value', () => {
    setBraidConfig({ dev: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const realm = createRealm();
    const realmLocation = realm.location;
    const realmObserver = realm.MutationObserver;

    installSharedGlobals(realm, window, ['location', 'MutationObserver', 'dataLayer'], 'cart');

    expect(realm.location).toBe(realmLocation);
    expect(realm.MutationObserver).toBe(realmObserver);
    expect(Object.getOwnPropertyDescriptor(realm, 'dataLayer')?.get).toBeTypeOf('function');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('[braid:cart]');
    expect(warn.mock.calls[0][0]).toContain('"location"');
  });

  it('skips silently outside dev mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installSharedGlobals(createRealm(), window, ['location'], 'cart');
    expect(warn).not.toHaveBeenCalled();
  });

  it("lets a fragment's function declaration shadow the name without throwing or touching the host", () => {
    const hostDataLayer: unknown[] = [];
    host.dataLayer = hostDataLayer;
    const realm = createRealm();
    const errors: unknown[] = [];
    realm.addEventListener('error', (event) => errors.push((event as ErrorEvent).error));

    installSharedGlobals(realm, window, ['dataLayer'], 'cart');
    run(realm, `function dataLayer() {}`);

    expect(errors).toEqual([]);
    expect(typeof realm.dataLayer).toBe('function');
    expect(host.dataLayer).toBe(hostDataLayer);
  });
});

describe('realm globals', () => {
  const frames: HTMLIFrameElement[] = [];

  afterEach(() => {
    frames.splice(0).forEach((frame) => frame.remove());
    delete (getBraidConfig() as { realmGlobals?: unknown }).realmGlobals;
    setBraidConfig({ dev: false });
    vi.restoreAllMocks();
  });

  function createRealm(): Window & Record<string, unknown> {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    frames.push(frame);
    return frame.contentWindow as Window & Record<string, unknown>;
  }

  it('calls the hook with the fragment id and its teardown signal', async () => {
    const hook = vi.fn(() => ({ fdc3: 'agent' }));
    setBraidConfig({ realmGlobals: hook });
    const signal = new AbortController().signal;

    expect(await resolveRealmGlobals('billing', signal)).toEqual({ fdc3: 'agent' });
    expect(hook).toHaveBeenCalledWith({ fragmentId: 'billing', signal });
  });

  it('gives nothing, and does not throw, when the hook throws or rejects', async () => {
    setBraidConfig({ dev: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const signal = new AbortController().signal;

    setBraidConfig({ realmGlobals: () => { throw new Error('boom'); } });
    expect(await resolveRealmGlobals('billing', signal)).toBeUndefined();
    setBraidConfig({ realmGlobals: async () => { throw new Error('boom'); } });
    expect(await resolveRealmGlobals('billing', signal)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('gives nothing without a hook', async () => {
    expect(await resolveRealmGlobals('billing', new AbortController().signal)).toBeUndefined();
  });

  it('defines plain values a classic script reads as bare identifiers', () => {
    const realm = createRealm();
    installRealmGlobals(realm, { fdc3: { id: 'billing' } }, 'billing');

    const script = realm.document.createElement('script');
    script.textContent = 'window.seen = fdc3.id;';
    realm.document.body.append(script);
    expect(realm.seen).toBe('billing');
    expect('fdc3' in window).toBe(false);
  });

  it('never replaces a name the realm already has', () => {
    const realm = createRealm();
    const location = realm.location;
    installRealmGlobals(realm, { location: 'elsewhere', document: null }, 'billing');

    expect(realm.location).toBe(location);
    expect(realm.document).not.toBeNull();
  });
});
