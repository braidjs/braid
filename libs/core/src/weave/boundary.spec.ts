import { versioned } from '@braidlabs/skew';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BraidError } from '../errors.js';
import { braidContext } from '../context/context-bus.js';
import { createFragmentEnv } from '../env/create-env.js';
import { FragmentEnv } from '../env/fragment-env.js';
import { createBoundaryChannel } from './channel.js';
import { createSameRealmBackingPair } from './same-realm-backing.js';
import { weaveId } from './envelope.js';
import { performHostHandshake } from './handshake.js';
import { attachContextRouter } from './context-bridge.js';
import { FRAGMENT_EVENT, FragmentEventPayload, PROPS_CHANGED } from './messages.js';
import { CloseReason, DIRTY, DirtyPayload, closeAndDispose } from './closing.js';

/**
 * The composition `<fragment-slot>` performs, minus the realm and the gateway.
 *
 * Worth testing at this seam rather than through the element: booting a real slot needs a gateway
 * to serve a realm stub, so a test that went through it would be testing fetch mocks. Everything
 * below this line is the code the slot actually runs.
 */

interface Mounted {
  env: FragmentEnv;
  events: Array<{ type: string; detail: unknown }>;
  dirty: Array<string | null>;
  setProps(props: Record<string, unknown>): void;
  /** The sequence `<fragment-slot>` runs on teardown, through the same shared helper it uses. */
  close(reason?: CloseReason): Promise<{ acknowledged: boolean; flushed: number; dropped: number }>;
  dispose(): void;
}

interface MountOptions {
  contextVersions?: Record<string, number>;
  props?: Record<string, unknown>;
  capabilities?: import('./capabilities.js').FragmentCapabilities;
}

async function mount(options: MountOptions = {}): Promise<Mounted> {
  const fragmentId = 'checkout';
  const instance = weaveId();
  const controller = new AbortController();
  const signal = controller.signal;

  const backings = createSameRealmBackingPair();
  const hostChannel = createBoundaryChannel({ backing: backings.host, fragmentId, instance, signal });
  const fragmentChannel = createBoundaryChannel({ backing: backings.fragment, fragmentId, instance, signal });

  const events: Array<{ type: string; detail: unknown }> = [];
  hostChannel.on(FRAGMENT_EVENT, (payload) => {
    const { type, detail } = (payload ?? {}) as FragmentEventPayload;
    events.push({ type, detail });
  });

  const dirty: Array<string | null> = [];
  hostChannel.on(DIRTY, (payload) => void dirty.push(((payload ?? {}) as DirtyPayload).reason));

  const host = document.createElement('fragment-slot');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const contentRoot = document.createElement('braid-document');
  shadowRoot.append(contentRoot);

  let props = structuredClone(options.props ?? {});

  const { env, opened } = createFragmentEnv({
    contentRoot,
    shadowRoot,
    routeUrl: '/checkout',
    channel: fragmentChannel,
    fragmentId,
    ...(options.contextVersions === undefined ? {} : { contextVersions: options.contextVersions }),
    signal,
  });

  await performHostHandshake({
    channel: hostChannel,
    fragmentId,
    instance,
    assertReachable: (versions) => {
      for (const [key, as] of Object.entries(versions)) braidContext.assertReachable(key, as, fragmentId);
    },
    openWith: (contextVersions) => ({
      context: attachContextRouter({
        bus: braidContext,
        channel: hostChannel,
        fragmentId,
        contextVersions,
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
        signal,
      }),
      props: structuredClone(props),
    }),
  });
  await opened;

  return {
    env,
    events,
    dirty,
    close: (reason: CloseReason = 'unmount') =>
      closeAndDispose({
        channel: hostChannel,
        fragmentId,
        reason,
        onOverrun: () => undefined,
        dispose: () => {
          controller.abort();
          hostChannel.close();
        },
      }),
    setProps(next) {
      props = structuredClone(next);
      hostChannel.send(PROPS_CHANGED, { props: structuredClone(props) });
    },
    dispose() {
      controller.abort();
    },
  };
}

/** A macrotask turn: enough for a push to cross and be applied. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => braidContext.clear());

describe('context across the boundary', () => {
  it('seeds the mirror at OPEN, so a read is synchronous and needs no round trip', async () => {
    braidContext.set('user', { id: 'u1' });
    const mounted = await mount();

    // The assertion the whole mirror design exists to protect: `get` returns a value, not a promise.
    expect(mounted.env.context.get('user')).toEqual({ id: 'u1' });
    mounted.dispose();
  });

  it('pushes a later change to a subscriber', async () => {
    braidContext.set('cart', { items: 0 });
    const mounted = await mount();
    const seen = vi.fn();
    mounted.env.context.subscribe('cart', seen);

    braidContext.set('cart', { items: 3 });
    await flush();

    expect(seen).toHaveBeenCalledWith({ items: 3 });
    expect(mounted.env.context.get('cart')).toEqual({ items: 3 });
    mounted.dispose();
  });

  it('delivers a key first published after the fragment mounted', async () => {
    const mounted = await mount();
    const seen = vi.fn();
    mounted.env.context.subscribe('promo', seen);

    // The case `subscribe`-per-key could not serve, and the reason the bus grew `observe()`.
    braidContext.set('promo', { code: 'SPRING' });
    await flush();

    expect(seen).toHaveBeenCalledWith({ code: 'SPRING' });
    mounted.dispose();
  });

  it('projects a delivery down to the version the fragment declared', async () => {
    interface V1 { ticker: string }
    interface V2 extends V1 { market: string }
    const Instrument = versioned<V1>('spec.instrument').next<V2>('carry the MIC market identifier', {
      up: (v1) => ({ ...v1, market: '' }),
      down: ({ market: _market, ...rest }) => rest,
      lossy: ['market'],
    });
    braidContext.register('instrument', Instrument);
    braidContext.set('instrument', { ticker: 'ACME', market: 'XNYS' });

    const mounted = await mount({ contextVersions: { instrument: 1 } });

    // Projection ran in the host, once, before the value crossed — the fragment's realm never
    // sees a shape it did not ask for, and never runs the migration engine itself.
    expect(mounted.env.context.get('instrument')).toEqual({ ticker: 'ACME' });
    mounted.dispose();
  });

  it('re-projects when a schema is registered after the value was published', async () => {
    braidContext.set('instrument', { ticker: 'ACME', market: 'XNYS' });
    const mounted = await mount({ contextVersions: { instrument: 1 } });
    expect(mounted.env.context.get('instrument')).toEqual({ ticker: 'ACME', market: 'XNYS' });

    interface V1 { ticker: string }
    interface V2 extends V1 { market: string }
    braidContext.register(
      'instrument',
      versioned<V1>('spec.instrument').next<V2>('carry the MIC market identifier', {
        up: (v1) => ({ ...v1, market: '' }),
        down: ({ market: _market, ...rest }) => rest,
        lossy: ['market'],
      }),
    );
    await flush();

    // A mirror that only updated on `set` would hold the pre-registration shape until the next
    // publication — which for a slow-moving key may be never.
    expect(mounted.env.context.get('instrument')).toEqual({ ticker: 'ACME' });
    mounted.dispose();
  });

  it('refuses the handshake when a declared version cannot be reached', async () => {
    interface V1 { ticker: string }
    interface V2 extends V1 { market: string }
    braidContext.register(
      'instrument',
      versioned<V1>('spec.instrument').next<V2>('add market, no inverse', (v1) => ({ ...v1, market: '' })),
    );

    const error = await mount({ contextVersions: { instrument: 1 } }).catch((e: unknown) => e);

    // Refused before any state crossed, rather than at first subscribe — one step earlier than the
    // bus's own check, and with the fragment's name on it either way.
    expect(error).toBeInstanceOf(BraidError);
    expect((error as BraidError).stage).toBe('context-version');
    expect((error as BraidError).message).toContain('no down migration');
  });

  it('leaves other keys intact when one becomes unprojectable mid-flight', async () => {
    braidContext.set('cart', { items: 1 });
    const mounted = await mount({ contextVersions: { instrument: 1 } });
    const cartSeen = vi.fn();
    mounted.env.context.subscribe('cart', cartSeen);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    interface V1 { ticker: string }
    interface V2 extends V1 { market: string }
    braidContext.register(
      'instrument',
      versioned<V1>('spec.instrument').next<V2>('add market, no inverse', (v1) => ({ ...v1, market: '' })),
    );
    braidContext.set('instrument', { ticker: 'ACME', market: 'XNYS' });
    braidContext.set('cart', { items: 2 });
    await flush();

    expect(mounted.env.context.get('instrument')).toBeUndefined();
    expect(cartSeen).toHaveBeenCalledWith({ items: 2 });
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
    mounted.dispose();
  });

  it('stops delivering once the instance is disposed', async () => {
    braidContext.set('cart', { items: 0 });
    const mounted = await mount();
    const seen = vi.fn();
    mounted.env.context.subscribe('cart', seen);

    mounted.dispose();
    braidContext.set('cart', { items: 9 });
    await flush();

    expect(seen).not.toHaveBeenCalled();
  });
});

describe('props across the boundary', () => {
  it('arrives with the opening state', async () => {
    const mounted = await mount({ props: { sku: 'A1' } });
    expect(mounted.env.props).toEqual({ sku: 'A1' });
    mounted.dispose();
  });

  it('pushes a change to onPropsChanged listeners', async () => {
    const mounted = await mount({ props: { sku: 'A1' } });
    const seen = vi.fn();
    mounted.env.onPropsChanged(seen);

    mounted.setProps({ sku: 'B2' });
    await flush();

    expect(seen).toHaveBeenCalledWith({ sku: 'B2' });
    expect(mounted.env.props).toEqual({ sku: 'B2' });
    mounted.dispose();
  });

  it('gives the fragment a copy, not the host object', async () => {
    const props = { nested: { deep: 1 } };
    const mounted = await mount({ props });

    // Before Weave, `getProps()` returned the host's live object: a fragment could mutate the
    // host's state, and see host mutations the host never announced.
    (mounted.env.props as { nested: { deep: number } }).nested.deep = 99;
    expect(props.nested.deep).toBe(1);
    mounted.dispose();
  });
});

describe('events across the boundary', () => {
  it('carries an emit to the host', async () => {
    const mounted = await mount();

    mounted.env.emit('checkout:complete', { orderId: 'o1' });
    await flush();

    expect(mounted.events).toEqual([{ type: 'checkout:complete', detail: { orderId: 'o1' } }]);
    mounted.dispose();
  });
});

describe('closing across the boundary', () => {
  it('runs the fragment’s closing work before its signal aborts', async () => {
    const mounted = await mount();
    let abortedDuringClose: boolean | undefined;
    mounted.env.onClosing(async () => {
      await Promise.resolve();
      // The invariant the phase exists for. A dispose ordered before the await would abort here,
      // and the flush below would be running against released resources.
      abortedDuringClose = mounted.env.signal.aborted;
      return { flushed: 50, dropped: 0 };
    });

    const result = await mounted.close();

    expect(abortedDuringClose).toBe(false);
    expect(result).toMatchObject({ acknowledged: true, flushed: 50, dropped: 0 });
    expect(mounted.env.signal.aborted).toBe(true);
  });

  it('passes the reason through to the fragment', async () => {
    const mounted = await mount();
    const seen = vi.fn();
    mounted.env.onClosing(seen);

    await mounted.close('reload');

    expect(seen).toHaveBeenCalledWith('reload');
  });

  it('carries a dirty declaration to the host as it changes', async () => {
    const mounted = await mount();

    mounted.env.setDirty('an unsent order');
    await flush();

    expect(mounted.dirty).toEqual(['an unsent order']);
    mounted.dispose();
  });

  it('closes a fragment that declared no closing work at all', async () => {
    const mounted = await mount();
    await expect(mounted.close()).resolves.toMatchObject({ acknowledged: true, flushed: 0 });
  });
});

describe('context grants', () => {
  it('keeps an ungranted key out of the fragment’s mirror entirely', async () => {
    braidContext.set('user', { id: 'u1' });
    braidContext.set('pricing', { margin: 0.4 });

    const mounted = await mount({ capabilities: { context: { read: ['user'] } } });

    expect(mounted.env.context.get('user')).toEqual({ id: 'u1' });
    // Undefined, not an error: an ungranted key must look exactly like a key nobody published, or
    // the refusal itself leaks the shape of the host's context to code that was denied it.
    expect(mounted.env.context.get('pricing')).toBeUndefined();
    mounted.dispose();
  });

  it('does not deliver later changes to an ungranted key', async () => {
    const mounted = await mount({ capabilities: { context: { read: ['user'] } } });
    const seen = vi.fn();
    mounted.env.context.subscribe('pricing', seen);

    braidContext.set('pricing', { margin: 0.5 });
    await flush();

    // Not merely "no value" — *no message*. Sending a valueless change would produce the right
    // return from `get()` while telling the fragment the key exists and exactly when it changes,
    // which is a timing channel on the data the grant was written to withhold.
    expect(seen).not.toHaveBeenCalled();
    mounted.dispose();
  });

  it('still clears a granted key that becomes unprojectable', async () => {
    braidContext.set('instrument', { ticker: 'ACME', market: 'XNYS' });
    const mounted = await mount({
      contextVersions: { instrument: 1 },
      capabilities: { context: { read: ['instrument'] } },
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    interface V1 { ticker: string }
    interface V2 extends V1 { market: string }
    braidContext.register(
      'instrument',
      versioned<V1>('spec.instrument').next<V2>('add market, no inverse', (v1) => ({ ...v1, market: '' })),
    );
    await flush();

    // A granted key the host can no longer project is different from a denied one: the fragment was
    // always allowed to know it exists, so clearing a now-stale mirror entry is the honest move.
    expect(mounted.env.context.get('instrument')).toBeUndefined();
    consoleError.mockRestore();
    mounted.dispose();
  });

  it('delivers everything when no grant is declared', async () => {
    braidContext.set('pricing', { margin: 0.4 });
    const mounted = await mount();

    expect(mounted.env.context.get('pricing')).toEqual({ margin: 0.4 });
    mounted.dispose();
  });
});
