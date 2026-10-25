import {
  BasicDirectory,
  ChannelType,
  DefaultFDC3Server,
  IntentHandler,
  State,
  type AppRegistration,
  type ChannelState,
  type DirectoryApp,
  type InstanceID,
  type ServerContext,
} from '@finos/fdc3-web-impl';
import {
  AbstractMessaging,
  DefaultAppSupport,
  DefaultChannelSupport,
  DefaultHeartbeatSupport,
  DefaultIntentSupport,
  DesktopAgentProxy,
  type RegisterableListener,
} from '@finos/fdc3-agent-proxy';
import { ChannelError, LogLevel, OpenError, type AppIdentifier, type AppIntent, type DesktopAgent } from '@finos/fdc3-standard';

/**
 * An FDC3 2.2 Desktop Agent for one Braid page.
 *
 * The page is the desktop: the host runs the agent, and each composed fragment is an app instance
 * on it. The agent is the FINOS reference implementation — `DefaultFDC3Server` from
 * `@finos/fdc3-web-impl` for the agent, `DesktopAgentProxy` from `@finos/fdc3-agent-proxy` for each
 * app's `fdc3` — so channel and intent semantics are FDC3's own rather than an approximation of
 * them. What Braid adds is the part FDC3 for the Web leaves to the platform:
 *
 * - **Identity is known, not claimed.** A web app normally proves who it is with the Web Connection
 *   Protocol, matching its URL against the directory. A fragment's identity is its registry id,
 *   which the host already knows when it boots the fragment, so each fragment is registered under
 *   that id directly and no handshake runs.
 * - **Transport is in-process.** The proxy and the agent exchange structured clones, one task
 *   per message — the isolation and ordering a MessagePort gives, without one.
 * - **Lifetime is the fragment's.** When the fragment is torn down its instance is terminated: its
 *   listeners stop receiving and `findInstances` no longer reports it.
 */
export interface BraidDesktopAgentOptions {
  /**
   * The App Directory records the agent resolves against — the `applications` of a Braid AppD
   * listing (`createRegistryApi({ appd })` or the gateway's `discovery: { appd: true }`). Each
   * record's `appId` is a fragment id; a fragment with no record gets no `fdc3`.
   */
  directory: readonly DirectoryApp[];
}

export interface BraidDesktopAgent {
  /**
   * The hook for `initBraid({ realmGlobals })`: a fragment in the directory gets `{ fdc3 }`, an
   * agent bound to its id, before any of its code runs; its signal releases the instance.
   */
  realmGlobals(fragment: { fragmentId: string; signal: AbortSignal }): Promise<{ fdc3: DesktopAgent } | undefined>;
}

/** A request is answered within this, or the proxy reports `ApiTimeout`. */
const MESSAGE_TIMEOUT_MS = 10_000;
/** How long a raised intent may take to be handled. */
const INTENT_TIMEOUT_MS = 20_000;

/** FDC3's eight recommended user channels, as `@finos/fdc3-standard` defines them. */
const USER_CHANNELS: readonly [string, string][] = [
  ['red', '1'],
  ['orange', '2'],
  ['yellow', '3'],
  ['green', '4'],
  ['cyan', '5'],
  ['blue', '6'],
  ['magenta', '7'],
  ['purple', '8'],
];

/** The proxy's intent resolver and channel selector, when the host supplies no UI for either. */
const NO_UI = {
  connect: async () => undefined,
  disconnect: async () => undefined,
  // no resolver UI: a raise that needs a choice is refused, as FDC3 says, with UserCancelledResolution
  chooseIntent: async () => undefined,
  updateChannel: async () => undefined,
  setChannelChangeCallback: () => undefined,
};

export function createBraidDesktopAgent(options: BraidDesktopAgentOptions): BraidDesktopAgent {
  // a directory that failed to load is an empty one, not a page that fails to compose
  const directory = new BasicDirectory(Array.isArray(options.directory) ? [...options.directory] : []);
  const context = new BraidServerContext(taskQueue());
  const userChannels: ChannelState[] = USER_CHANNELS.map(([color, glyph]) => ({
    id: `fdc3.channel.${glyph}`,
    type: ChannelType.user,
    context: [],
    displayMetadata: { name: `Channel ${glyph}`, color, glyph },
  }));
  const server = new DefaultFDC3Server(context, directory, userChannels, false, INTENT_TIMEOUT_MS, MESSAGE_TIMEOUT_MS);
  // which instances are listening for what: the agent's intent handler is the source of truth
  const intentHandler = server.handlers.find((handler): handler is IntentHandler => handler instanceof IntentHandler);
  context.hasListener = (instanceId, intent) => intentHandler?.hasListener(instanceId, intent) ?? false;

  async function connect(appId: string, signal: AbortSignal): Promise<DesktopAgent | undefined> {
    const instanceId = context.createUUID();
    let open = true;

    // A fragment holds its `fdc3` and everything reachable from it. The server — and through it
    // every other instance — is reachable only through this closure, never as a property, so a
    // fragment can speak only as itself.
    const messaging = new InProcessMessaging(
      { appId, instanceId },
      (message) => server.receive(context.targetInstance(message) as never, instanceId),
      () => open,
    );
    context.setInstanceDetails(instanceId, { appId, instanceId, state: State.Connected });
    context.onMessage(instanceId, (message) => {
      if (open) messaging.deliver(message);
    });

    const heartbeat = new DefaultHeartbeatSupport(messaging);
    const channels = new DefaultChannelSupport(messaging, NO_UI, MESSAGE_TIMEOUT_MS);
    const intents = new DefaultIntentSupport(messaging, NO_UI, MESSAGE_TIMEOUT_MS, INTENT_TIMEOUT_MS);
    const apps = new DefaultAppSupport(messaging, MESSAGE_TIMEOUT_MS, INTENT_TIMEOUT_MS);
    // the proxy logs every message at its default level; warnings and errors are what a host wants
    const agent = new DesktopAgentProxy(heartbeat, channels, intents, apps, [heartbeat, channels, NO_UI, NO_UI], LogLevel.WARN);

    const release = () => {
      if (!open) return;
      open = false;
      // terminates the instance and drops its listeners and channel membership on the agent side
      server.cleanup(instanceId);
      // the agent will not answer what was in flight, so answer it here
      messaging.refuseInFlight();
    };
    signal.addEventListener('abort', release, { once: true });

    try {
      // a teardown during connect refuses its requests at once (see `post`), so this settles promptly
      await agent.connect();
    } catch {
      release();
      return undefined;
    }
    return signal.aborted ? undefined : agent;
  }

  return {
    async realmGlobals({ fragmentId, signal }) {
      if (signal.aborted || directory.retrieveAppsById(fragmentId).length === 0) return undefined;
      const fdc3 = await connect(fragmentId, signal);
      return fdc3 ? { fdc3 } : undefined;
    },
  };
}

/**
 * One app instance's side of the in-process transport. State is in `#private` fields, which a
 * fragment cannot read through the proxy that holds this.
 */
class InProcessMessaging extends AbstractMessaging {
  readonly #send: (message: object) => Promise<void>;
  readonly #isOpen: () => boolean;
  readonly #listeners = new Map<string, RegisterableListener>();
  /** Requests sent and not yet answered, by request id. */
  readonly #inFlight = new Map<string, object>();

  constructor(identity: AppIdentifier, send: (message: object) => Promise<void>, isOpen: () => boolean) {
    super(identity);
    this.#send = send;
    this.#isOpen = isOpen;
  }

  createUUID(): string {
    return crypto.randomUUID();
  }

  /**
   * Requests are always answered: refused here, at once, after teardown or when the message
   * cannot be cloned (a context carrying a function). Dropped, the caller would wait out its
   * timeout; thrown, the proxy — which does not await `post` — would leave it unhandled.
   */
  async post(message: object): Promise<void> {
    if (!this.#isOpen()) return this.#refuse(message, 'AgentDisconnected');
    // launching a fragment is the host's to do, and is not wired yet
    if ((message as { type?: unknown }).type === 'openRequest') return this.#refuse(message, OpenError.ErrorOnLaunch);
    let copy: object;
    try {
      // a clone, as a MessagePort would make: neither side holds the other's objects
      copy = structuredClone(message);
    } catch {
      return this.#refuse(message, ChannelError.MalformedContext);
    }
    const { type, meta } = message as { type?: unknown; meta?: { requestUuid?: unknown } };
    if (typeof type === 'string' && type.endsWith('Request') && typeof meta?.requestUuid === 'string') {
      this.#inFlight.set(meta.requestUuid, message);
    }
    await this.#send(copy);
  }

  /**
   * Answers every request still waiting, after the instance is torn down. An intent's result is
   * the exception: the proxy sends it without waiting on the answer, so refusing it would surface
   * as an unhandled rejection — and the raiser already has whatever the agent will give it.
   */
  refuseInFlight(): void {
    for (const message of this.#inFlight.values()) {
      if ((message as { type?: unknown }).type === 'intentResultRequest') this.#answer(message, {});
      else this.#refuse(message, 'AgentDisconnected');
    }
  }

  /** A message from the agent, to whichever of this instance's listeners it is for. */
  deliver(message: object): void {
    const requestUuid = (message as { meta?: { requestUuid?: unknown } }).meta?.requestUuid;
    if (typeof requestUuid === 'string') this.#inFlight.delete(requestUuid);
    for (const listener of [...this.#listeners.values()]) {
      // one app handler that throws must not starve the rest, or a request waiting on a response
      try {
        if (listener.filter(message as never)) listener.action(message as never);
      } catch (error) {
        if (typeof reportError === 'function') reportError(error);
        else console.error(error);
      }
    }
  }

  register(listener: RegisterableListener): void {
    if (listener.id) this.#listeners.set(listener.id, listener);
  }

  unregister(id: string): void {
    this.#listeners.delete(id);
  }

  createMeta() {
    return { requestUuid: this.createUUID(), timestamp: new Date(), source: this.getAppIdentifier() };
  }

  async disconnect(): Promise<void> {
    this.#listeners.clear();
  }

  #refuse(message: object, error: string): void {
    this.#answer(message, { error });
  }

  /** Delivers a response to `message` as if from the agent. Only requests have one. */
  #answer(message: object, payload: object): void {
    const { type, meta } = message as { type?: unknown; meta?: { requestUuid?: unknown } };
    if (typeof type !== 'string' || !type.endsWith('Request') || typeof meta?.requestUuid !== 'string') return;
    const response = {
      type: type.replace(/Request$/, 'Response'),
      meta: { requestUuid: meta.requestUuid, responseUuid: this.createUUID(), timestamp: new Date() },
      payload,
    };
    queueMicrotask(() => this.deliver(response));
  }
}

/**
 * Runs each callback as its own task, in order — as a MessagePort delivers messages. The agent
 * relies on that: it answers a listener's registration and then at once delivers an intent held
 * for it, and the proxy only finishes registering the listener in the continuations of the first.
 * On one microtask queue the intent would overtake them and be lost.
 */
function taskQueue(): (task: () => void) => void {
  const tasks: (() => void)[] = [];
  const channel = new MessageChannel();
  channel.port1.onmessage = () => tasks.shift()?.();
  // in Node, an idle port would otherwise keep the process alive
  (channel.port1 as { unref?: () => void }).unref?.();
  return (task) => {
    tasks.push(task);
    channel.port2.postMessage(null);
  };
}

/** The agent's view of the page: instances are connected fragments, and nothing is launched. */
class BraidServerContext implements ServerContext<AppRegistration> {
  /**
   * Registrations are plain data: the agent copies them into its responses (an intent's candidate
   * apps), so a delivery callback kept on one would be sent along with it.
   */
  private readonly instances = new Map<InstanceID, AppRegistration>();
  private readonly deliveries = new Map<InstanceID, (message: object) => void>();
  constructor(private readonly schedule: (task: () => void) => void) {}

  /** Whether an instance has an intent listener for `intent`; set by the agent. */
  hasListener: (instanceId: InstanceID, intent: string) => boolean = () => false;

  /** Live instances of an app, oldest first. */
  private live(appId: string): AppRegistration[] {
    return [...this.instances.values()].filter((instance) => instance.appId === appId && instance.state === State.Connected);
  }

  /**
   * A raise that names an app but no instance is resolved here to the instance that will take
   * it: the one listening for the intent, or — when none is yet — the app's only instance, so the
   * agent holds the intent until that fragment's listener arrives. FINOS would otherwise treat it
   * as a request to launch the app, which a Braid page cannot do.
   */
  targetInstance(message: object): object {
    const { type, payload } = message as { type?: unknown; payload?: { intent?: unknown; app?: { appId?: unknown; instanceId?: unknown } } };
    const app = payload?.app;
    if (type !== 'raiseIntentRequest' || typeof payload?.intent !== 'string' || typeof app?.appId !== 'string' || app.instanceId) {
      return message;
    }
    const live = this.live(app.appId);
    const listening = live.filter((instance) => this.hasListener(instance.instanceId, payload.intent as string));
    const target = listening.length === 1 ? listening[0] : listening.length === 0 && live.length === 1 ? live[0] : undefined;
    return target ? { ...message, payload: { ...payload, app: { appId: target.appId, instanceId: target.instanceId } } } : message;
  }

  /** Where messages for an instance go. */
  onMessage(id: InstanceID, deliver: (message: object) => void): void {
    this.deliveries.set(id, deliver);
  }

  createUUID(): string {
    return crypto.randomUUID();
  }

  async post(message: object, instanceId: InstanceID): Promise<void> {
    const deliver = this.deliveries.get(instanceId);
    if (!deliver || this.instances.get(instanceId)?.state === State.Terminated) return;
    const copy = structuredClone(message);
    this.schedule(() => deliver(copy));
  }

  /**
   * Nothing is launched: `fdc3.open` is refused before it reaches the agent, and launching a
   * fragment is the host's to do. The agent still calls this when it holds an intent for an app
   * that is mounted but not yet listening (see {@link narrowIntents}) — the instance it waits for
   * already exists, so this names it. It never rejects: the agent does not handle a rejection here.
   */
  async open(appId: string): Promise<InstanceID> {
    return this.live(appId)[0]?.instanceId ?? this.createUUID();
  }

  async close(): Promise<void> {
    // fragments are torn down by their host, not by the agent
  }

  setFDC3Server(): void {
    // the server is held by the agent that created this context
  }

  setInstanceDetails(id: InstanceID, details: AppRegistration): void {
    this.instances.set(id, details);
  }

  getInstanceDetails(id: InstanceID): AppRegistration | undefined {
    return this.instances.get(id);
  }

  async setAppState(id: InstanceID, state: State): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) return;
    instance.state = state;
    // a terminated fragment is gone for good; it never reconnects under the same instance
    if (state === State.Terminated) {
      this.instances.delete(id);
      this.deliveries.delete(id);
    }
  }

  async getConnectedApps(): Promise<AppRegistration[]> {
    return [...this.instances.values()].filter((instance) => instance.state === State.Connected);
  }

  async getAllApps(): Promise<AppRegistration[]> {
    return [...this.instances.values()];
  }

  async isAppConnected(id: InstanceID): Promise<boolean> {
    return this.instances.get(id)?.state === State.Connected;
  }

  log(): void {
    // quiet: the proxy rejects with FDC3 errors, which is what an app sees
  }

  provider(): string {
    return 'Braid';
  }

  providerVersion(): string {
    // the release stamps versions into the built package.json only, so the source has none to give
    return '';
  }

  fdc3Version(): string {
    return '2.2';
  }

  /**
   * The candidates an intent may go to, given that nothing can be launched:
   *
   * - an instance only once it listens for the intent — before then, sending it the intent would
   *   lose it;
   * - an app without an instance (the directory's entry) only while one is mounted and none of its
   *   instances listens yet — the agent then holds the intent until the listener arrives.
   *
   * An app with no live instance drops out, which makes the raise a clean `NoAppsFound`.
   */
  async narrowIntents(_raiser: AppIdentifier, appIntents: AppIntent[]): Promise<AppIntent[]> {
    return appIntents
      .map((appIntent) => {
        const listening = appIntent.apps.filter(
          (app) => app.instanceId !== undefined && this.hasListener(app.instanceId, appIntent.intent.name),
        );
        const waiting = appIntent.apps.filter(
          (app) =>
            app.instanceId === undefined &&
            this.live(app.appId).length > 0 &&
            !listening.some((candidate) => candidate.appId === app.appId),
        );
        return { ...appIntent, apps: [...listening, ...waiting] };
      })
      .filter((appIntent) => appIntent.apps.length > 0);
  }
}
