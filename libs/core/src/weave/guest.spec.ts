import { afterEach, describe, expect, it, vi } from 'vitest';
import { BraidError } from '../errors.js';
import { braidContext } from '../context/context-bus.js';
import { SANDBOX_CONNECT, SANDBOX_READY } from '../realm/sandbox-realm.js';
import { createBoundaryChannel } from './channel.js';
import { createPortBacking } from './port-backing.js';
import { attachContextRouter } from './context-bridge.js';
import { performHostHandshake } from './handshake.js';
import { startHostLiveness, LivenessState } from './liveness.js';
import { closeAndDispose, DIRTY, DirtyPayload } from './closing.js';
import { FRAGMENT_EVENT, FragmentEventPayload, PROPS_CHANGED } from './messages.js';
import { connectToBraidHost, GuestSession } from './guest.js';

/**
 * The untrusted tier end-to-end, over a real `MessagePort`.
 *
 * **What this does not prove.** jsdom has no second origin and cannot create a real cross-origin
 * frame, so the browser-enforced half — that the guest cannot read the host's `document.cookie` or
 * reach into its DOM — is asserted here only structurally: by refusing a same-origin src, by pinning
 * both directions of the connect handshake, and by the shape of what a `GuestSession` exposes. The
 * enforcement itself is the browser's, and confirming it needs a browser. That gap is real and is
 * recorded in the plan rather than papered over.
 *
 * What this *does* prove is the part Braid is responsible for: that everything built in Phases 1–4
 * runs unchanged across a port, with no same-origin assumption left in it.
 */

const HOST_ORIGIN = 'https://portal.example.com';

interface Connected {
  session: GuestSession;
  events: Array<{ type: string; detail: unknown }>;
  dirty: Array<string | null>;
  states: LivenessState[];
  setProps(props: Record<string, unknown>): void;
  close(): Promise<{ acknowledged: boolean; flushed: number; dropped: number }>;
  dispose(): void;
}

/** Establishes a session the way a host and a framed guest would, minus the frame. */
async function connect(options: { props?: Record<string, unknown>; watchLiveness?: boolean } = {}): Promise<Connected> {
  const fragmentId = 'analytics';
  const instance = 'instance-1';
  const controller = new AbortController();
  const signal = controller.signal;
  const transport = new MessageChannel();

  const hostChannel = createBoundaryChannel({
    backing: createPortBacking(transport.port1),
    fragmentId,
    instance,
    signal,
  });

  const events: Array<{ type: string; detail: unknown }> = [];
  hostChannel.on(FRAGMENT_EVENT, (payload) => {
    const { type, detail } = (payload ?? {}) as FragmentEventPayload;
    events.push({ type, detail });
  });

  const dirty: Array<string | null> = [];
  hostChannel.on(DIRTY, (payload) => void dirty.push(((payload ?? {}) as DirtyPayload).reason));

  const states: LivenessState[] = [];

  // The guest attaches its window listener synchronously, so the connect offer can follow at once.
  const connecting = connectToBraidHost({ hostOrigin: HOST_ORIGIN, beatIntervalMs: 50 });

  window.dispatchEvent(
    new MessageEvent('message', {
      data: { braid: SANDBOX_CONNECT, v: 1, fragmentId, instance },
      origin: HOST_ORIGIN,
      ports: [transport.port2],
    }),
  );

  let props = structuredClone(options.props ?? {});

  const handshaking = performHostHandshake({
    channel: hostChannel,
    fragmentId,
    instance,
    assertReachable: (versions) => {
      for (const [key, as] of Object.entries(versions)) braidContext.assertReachable(key, as, fragmentId);
    },
    openWith: (contextVersions) => ({
      context: attachContextRouter({ bus: braidContext, channel: hostChannel, fragmentId, contextVersions, signal }),
      props: structuredClone(props),
    }),
  });

  /**
   * Started before the handshake resolves, exactly as `<fragment-slot>` does.
   *
   * Registering it afterwards is a race: the guest schedules its opening beat as soon as it is
   * open, and if the host is not listening yet that beat is simply lost. This test caught that as a
   * one-in-six flake, which is how the `armAfter` split came about.
   */
  const { promise: mounted, resolve: markMounted } = Promise.withResolvers<void>();
  if (options.watchLiveness) {
    startHostLiveness({
      channel: hostChannel,
      instance,
      signal,
      beatIntervalMs: 50,
      graceBeats: 3,
      goneAfterMs: 300,
      armAfter: mounted,
      onState: (state) => states.push(state),
    });
  }

  const [session] = await Promise.all([connecting, handshaking]);
  markMounted();

  return {
    session,
    events,
    dirty,
    states,
    setProps(next) {
      props = structuredClone(next);
      hostChannel.send(PROPS_CHANGED, { props: structuredClone(props) });
    },
    close: () =>
      closeAndDispose({
        channel: hostChannel,
        fragmentId,
        reason: 'unmount',
        onOverrun: () => undefined,
        dispose: () => controller.abort(),
      }),
    dispose: () => controller.abort(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

afterEach(() => braidContext.clear());

describe('origin pinning', () => {
  it('ignores a connect offer from any origin but the pinned host', async () => {
    const transport = new MessageChannel();
    const connecting = connectToBraidHost({ hostOrigin: HOST_ORIGIN, timeoutMs: 60 });

    // A fragment that accepted a channel from any parent could be framed by an attacker's page,
    // handed a plausible context, and induced to render a user's data where it can be read.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { braid: SANDBOX_CONNECT, v: 1, fragmentId: 'analytics', instance: 'i' },
        origin: 'https://attacker.example.com',
        ports: [transport.port2],
      }),
    );

    const error = await connecting.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BraidError);
    expect((error as BraidError).stage).toBe('handshake');
  });

  it('ignores a message from the right origin that is not a connect offer', async () => {
    const connecting = connectToBraidHost({ hostOrigin: HOST_ORIGIN, timeoutMs: 60 });

    window.dispatchEvent(
      new MessageEvent('message', { data: { hello: 'there' }, origin: HOST_ORIGIN }),
    );
    window.dispatchEvent(
      new MessageEvent('message', { data: { braid: SANDBOX_CONNECT, v: 1 }, origin: HOST_ORIGIN }),
    );

    // The second carries no port: `event.data` is sender-controlled and worth distrusting even
    // from a pinned origin, where `event.origin` is not.
    await expect(connecting).rejects.toThrow(BraidError);
  });

  it('announces readiness so a host that gave up waiting can offer again', () => {
    const posted = vi.fn();
    const original = window.parent.postMessage;
    Object.defineProperty(window, 'parent', { value: { postMessage: posted }, configurable: true });

    void connectToBraidHost({ hostOrigin: HOST_ORIGIN, timeoutMs: 60 }).catch(() => undefined);

    // Announced after the listener is attached, so the load-event and script-evaluation orderings
    // both converge.
    expect(posted).toHaveBeenCalledWith({ braid: SANDBOX_READY, v: 1 }, HOST_ORIGIN);
    Object.defineProperty(window, 'parent', { value: { postMessage: original }, configurable: true });
  });

  it('fails with a named error when nobody offers a connection', async () => {
    const error = await connectToBraidHost({ hostOrigin: HOST_ORIGIN, timeoutMs: 30 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BraidError);
    expect((error as BraidError).fixHint).toContain(HOST_ORIGIN);
  });
});

describe('an untrusted session', () => {
  it('receives the opening context and props', async () => {
    braidContext.set('user', { id: 'u1' });
    const connected = await connect({ props: { placement: 'sidebar' } });

    expect(connected.session.context.get('user')).toEqual({ id: 'u1' });
    expect(connected.session.props).toEqual({ placement: 'sidebar' });
    connected.dispose();
  });

  it('receives later context changes', async () => {
    braidContext.set('cart', { items: 0 });
    const connected = await connect();
    const seen = vi.fn();
    connected.session.context.subscribe('cart', seen);

    braidContext.set('cart', { items: 4 });
    await settle();

    expect(seen).toHaveBeenCalledWith({ items: 4 });
    connected.dispose();
  });

  it('receives prop changes', async () => {
    const connected = await connect({ props: { placement: 'sidebar' } });
    const seen = vi.fn();
    connected.session.onPropsChanged(seen);

    connected.setProps({ placement: 'footer' });
    await settle();

    expect(seen).toHaveBeenCalledWith({ placement: 'footer' });
    connected.dispose();
  });

  it('emits events to the host', async () => {
    const connected = await connect();

    connected.session.emit('impression', { slot: 'sidebar' });
    await settle();

    expect(connected.events).toEqual([{ type: 'impression', detail: { slot: 'sidebar' } }]);
    connected.dispose();
  });

  it('beats, so the host reaches healthy', async () => {
    const connected = await connect({ watchLiveness: true });
    await settle();

    // Beats scheduled on the guest's *own* document — stronger evidence than the trusted tier can
    // offer, where the beat comes from a hidden frame rather than from the application itself.
    expect(connected.states).toContain('healthy');
    connected.dispose();
  });

  it('declares dirty state to the host', async () => {
    const connected = await connect();

    connected.session.setDirty('an unsent impression batch');
    await settle();

    expect(connected.dirty).toEqual(['an unsent impression batch']);
    connected.dispose();
  });

  it('closes gracefully, running its closing work first', async () => {
    const connected = await connect();
    let abortedDuringClose: boolean | undefined;
    connected.session.onClosing(async () => {
      await Promise.resolve();
      abortedDuringClose = connected.session.signal.aborted;
      return { flushed: 7, dropped: 0 };
    });

    const result = await connected.close();

    expect(abortedDuringClose).toBe(false);
    expect(result).toMatchObject({ acknowledged: true, flushed: 7 });
  });

  it('exposes state and lifecycle, and no handle to the host document', async () => {
    const connected = await connect();

    // A cross-origin fragment already owns a root, a document, a location and a history. Handing it
    // host-shaped substitutes would rebuild the illusion this tier exists to refuse.
    for (const absent of ['root', 'document', 'location', 'history', 'window']) {
      expect(connected.session).not.toHaveProperty(absent);
    }
    expect(connected.session).toHaveProperty('context');
    expect(connected.session).toHaveProperty('onClosing');
    connected.dispose();
  });
});
