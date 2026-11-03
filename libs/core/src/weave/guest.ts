import { BraidError } from '../errors.js';
import {
  SANDBOX_CONNECT,
  SANDBOX_READY,
  SandboxConnectMessage,
  SandboxReadyMessage,
} from '../realm/sandbox-realm.js';
import { BoundaryChannel, createBoundaryChannel } from './channel.js';
import { createPortBacking } from './port-backing.js';
import { createContextMirror } from './context-bridge.js';
import { createClosingCoordinator, ClosingCoordinator } from './closing.js';
import { FragmentContract } from './contract.js';
import { OpenPayload, answerHandshake } from './handshake.js';
import { startFragmentBeats } from './liveness.js';
import { FRAGMENT_EVENT, PROPS_CHANGED, PropsChangedPayload, SETTLED } from './messages.js';

/**
 * The guest half of the untrusted tier: what a cross-origin fragment runs to join a host page.
 *
 * ```ts
 * const session = await connectToBraidHost({ hostOrigin: 'https://portal.example.com' });
 * session.context.subscribe('user', renderUser);
 * session.onClosing(() => flushOutbox());
 * ```
 *
 * Note what a session **does not** have, compared with `FragmentEnv`: no `root`, no `document`, no
 * `location`, no `history`. A cross-origin fragment already owns all four — it is a whole document
 * with its own URL — and handing it host-shaped substitutes would be re-creating exactly the
 * illusion this tier exists to refuse. What crosses is state and lifecycle, nothing more.
 *
 * This is intentionally small. The framework adapters that make it ergonomic are Phase 7's job; this
 * is the primitive they will be written against, shipped now because the untrusted tier is not
 * testable without a guest and a tier with no guest is a tier nobody can use.
 */

export interface GuestSession {
  readonly channel: BoundaryChannel;
  readonly context: {
    get(key: string): unknown;
    subscribe(key: string, listener: (value: unknown) => void, options?: { signal?: AbortSignal; replay?: boolean }): () => void;
  };
  readonly props: Readonly<Record<string, unknown>>;
  onPropsChanged(listener: (props: Readonly<Record<string, unknown>>) => void): () => void;
  /** Fragment → host. Surfaced on the slot element as `braid:event`. */
  emit(type: string, detail?: unknown): void;
  /** Reports the fragment's first content as settled; see `FragmentEnv.settled`. */
  settled(): void;
  onClosing: ClosingCoordinator['onClosing'];
  setDirty: ClosingCoordinator['setDirty'];
  /** Aborts when the host closes the session. */
  readonly signal: AbortSignal;
  disconnect(): void;
}

export interface ConnectOptions {
  /**
   * The exact origin of the host page this fragment agrees to be embedded by.
   *
   * Required, and deliberately not defaulted to "whoever framed me". A fragment that accepted a
   * channel from any parent could be framed by an attacker's page, handed a plausible-looking
   * context, and induced to render a user's data inside a document that can screenshot it. The
   * fragment decides who may embed it, and this is where it says so.
   */
  hostOrigin: string;
  /** Skew chain versions this fragment can parse, per context key. */
  contextVersions?: Readonly<Record<string, number>>;
  contract?: FragmentContract;
  /** How long to wait for a host to offer a connection. */
  timeoutMs?: number;
  /** Beat interval; defaults to the shared two seconds. */
  beatIntervalMs?: number;
}

const CONNECT_TIMEOUT_MS = 15_000;

/** Waits for a host to offer a port, then completes the Weave handshake over it. */
export async function connectToBraidHost(options: ConnectOptions): Promise<GuestSession> {
  const { hostOrigin } = options;

  const { port, fragmentId, instance } = await acceptConnection(hostOrigin, options.timeoutMs ?? CONNECT_TIMEOUT_MS);

  const controller = new AbortController();
  const channel = createBoundaryChannel({
    backing: createPortBacking(port),
    fragmentId,
    instance,
    signal: controller.signal,
  });

  const context = createContextMirror(channel);
  const closing = createClosingCoordinator(channel);

  let props: Readonly<Record<string, unknown>> = {};
  const propsListeners = new Set<(props: Readonly<Record<string, unknown>>) => void>();
  const announceProps = () => {
    for (const listener of [...propsListeners]) {
      try {
        listener(props);
      } catch (error) {
        console.error('braid: a props listener threw', error);
      }
    }
  };

  channel.on(PROPS_CHANGED, (payload) => {
    props = ((payload ?? {}) as PropsChangedPayload).props ?? {};
    announceProps();
  });

  const opened = answerHandshake({
    channel,
    ...(options.contextVersions === undefined ? {} : { contextVersions: options.contextVersions }),
    ...(options.contract === undefined ? {} : { contract: options.contract }),
    onOpen(open: OpenPayload) {
      context.seed(open);
      props = open.props ?? {};
      announceProps();
    },
  });

  await opened;

  /**
   * Beats run on this document's own timers, which is what makes them meaningful here — more so
   * than on the trusted tier, where the "realm" is a hidden frame. A cross-origin fragment that
   * hangs is a whole application hanging, and its beats stop because its event loop stopped.
   */
  startFragmentBeats({
    channel,
    scheduler: window,
    signal: controller.signal,
    ...(options.beatIntervalMs === undefined ? {} : { beatIntervalMs: options.beatIntervalMs }),
  });

  return {
    channel,
    context: { get: (key) => context.get(key), subscribe: (key, listener, subscribeOptions) => context.subscribe(key, listener, { ...subscribeOptions, signal: subscribeOptions?.signal ?? controller.signal }) },
    get props() {
      return props;
    },
    onPropsChanged(listener) {
      propsListeners.add(listener);
      return () => void propsListeners.delete(listener);
    },
    emit: (type, detail) => channel.send(FRAGMENT_EVENT, { type, detail }),
    settled: () => channel.send(SETTLED),
    onClosing: closing.onClosing,
    setDirty: closing.setDirty,
    signal: controller.signal,
    disconnect: () => controller.abort(),
  };
}

/** Announces readiness, then takes the first port a pinned host offers. */
function acceptConnection(
  hostOrigin: string,
  timeoutMs: number,
): Promise<{ port: MessagePort; fragmentId: string; instance: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ port: MessagePort; fragmentId: string; instance: string }>();

  const onMessage = (event: MessageEvent) => {
    // Origin pinning, the whole point. `event.origin` is set by the browser and cannot be forged by
    // the sender, which is what makes it worth checking and `event.data` worth distrusting.
    if (event.origin !== hostOrigin) return;
    // And from the page that framed this one: another window on the host's origin, such as a
    // trusted fragment's realm or a popup, must not be able to hand this fragment a channel.
    if (event.source !== window.parent) return;

    const data = event.data as SandboxConnectMessage | undefined;
    if (data?.braid !== SANDBOX_CONNECT) return;

    const port = event.ports[0];
    if (!port) return;

    cleanup();
    resolve({ port, fragmentId: String(data.fragmentId ?? 'fragment'), instance: String(data.instance ?? 'instance') });
  };

  const timer = setTimeout(() => {
    cleanup();
    reject(
      new BraidError(`no braid host offered a connection within ${timeoutMs}ms`, {
        fragmentId: '<unconnected>',
        stage: 'handshake',
        fixHint: `check that this page is framed by "${hostOrigin}" and that the host mounts it with trust="untrusted"`,
      }),
    );
  }, timeoutMs);

  function cleanup() {
    clearTimeout(timer);
    window.removeEventListener('message', onMessage);
  }

  window.addEventListener('message', onMessage);

  /**
   * Announced *after* the listener is attached, because the host answers at once.
   *
   * The announcement is what connects: this frame runs in an opaque origin, which the host cannot
   * address by name, so it replies to the window that announced itself. The target origin still
   * pins the host — a page that framed this one from any other origin never receives it.
   */
  const ready: SandboxReadyMessage = { braid: SANDBOX_READY, v: 1 };
  window.parent?.postMessage(ready, hostOrigin);

  return promise;
}
