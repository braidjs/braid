import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The untrusted tier's context gate, through the real element.
 *
 * The gate itself is tested in capabilities.spec.ts; this pins the wiring. `#bootUntrusted` has to
 * tell the router it is routing for an untrusted fragment, or a slot with no grant falls back to
 * the trusted default and hands a third party every context key. The frame and the handshake are
 * stubbed — a real cross-origin frame cannot load here — so what runs is the slot's own code.
 */

const opened = vi.hoisted(() => [] as Array<{ fragmentId: string; context: Record<string, unknown> }>);

vi.mock('../realm/sandbox-realm.js', async (original) => {
  const actual = await original<typeof import('../realm/sandbox-realm.js')>();
  return {
    ...actual,
    createSandboxRealm: vi.fn(async (init: { fragmentId: string; src: string }) => ({
      kind: 'sandbox',
      fragmentId: init.fragmentId,
      frame: document.createElement('iframe'),
      origin: new URL(init.src).origin,
      port: new MessageChannel().port1,
      dispose: () => undefined,
    })),
  };
});

vi.mock('../weave/handshake.js', async (original) => {
  const actual = await original<typeof import('../weave/handshake.js')>();
  return {
    ...actual,
    performHostHandshake: vi.fn(
      async (options: { fragmentId: string; openWith: (versions: Record<string, number>) => { context: Record<string, unknown> } }) => {
        opened.push({ fragmentId: options.fragmentId, context: options.openWith({}).context });
      },
    ),
  };
});

const { FragmentSlot } = await import('./fragment-slot.js');
const { braidContext } = await import('../context/context-bus.js');
const { setBraidConfig } = await import('../config.js');

afterEach(() => {
  document.body.replaceChildren();
  opened.length = 0;
});

function mountUntrusted(name: string) {
  if (!customElements.get('fragment-slot')) customElements.define('fragment-slot', FragmentSlot);
  const slot = document.createElement('fragment-slot');
  slot.setAttribute('name', name);
  slot.setAttribute('trust', 'untrusted');
  slot.setAttribute('src', 'https://vendor.example.com/widget');
  document.body.append(slot);
}

describe('<fragment-slot trust="untrusted"> context', () => {
  it('opens with no context when the fragment has no grant, and with only what a grant names', async () => {
    setBraidConfig({ capabilities: { granted: { context: { read: ['user'] } } } });
    braidContext.set('user', { id: 'u1' });
    braidContext.set('session', { token: 'secret' });

    mountUntrusted('vendor');
    mountUntrusted('granted');
    await vi.waitFor(() => expect(opened).toHaveLength(2), { timeout: 5000 });

    const contextOf = (id: string) => opened.find((entry) => entry.fragmentId === id)?.context;
    expect(contextOf('vendor')).toEqual({});
    expect(contextOf('granted')).toEqual({ user: { id: 'u1' } });
  });
});
