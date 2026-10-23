import {
  BasicDirectory,
  ChannelType,
  DefaultFDC3Server,
  State,
  type AppRegistration,
  type ChannelState,
  type DirectoryApp,
  type FDC3Server,
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
import { LogLevel, OpenError, type AppIdentifier, type AppIntent, type DesktopAgent } from '@finos/fdc3-standard';

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
 * - **Transport is in-process.** The proxy and the agent talk through structured clones handed
 *   across on a microtask — the same isolation a MessagePort gives, without one.
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
  const directory = new BasicDirectory([...options.directory]);
  const context = new BraidServerContext();
  const userChannels: ChannelState[] = USER_CHANNELS.map(([color, glyph]) => ({
    id: `fdc3.channel.${glyph}`,
    type: ChannelType.user,
    context: [],
    displayMetadata: { name: `Channel ${glyph}`, color, glyph },
  }));
  const server = new DefaultFDC3Server(context, directory, userChannels, false, INTENT_TIMEOUT_MS, MESSAGE_TIMEOUT_MS);

  async function connect(appId: string, signal: AbortSignal): Promise<DesktopAgent> {
    const instanceId = context.createUUID();
    const listeners = new Map<string, RegisterableListener>();
    let open = true;

    context.setInstanceDetails(instanceId, { appId, instanceId, state: State.Connected });
    context.onMessage(instanceId, (message) => {
      if (!open) return;
      for (const listener of [...listeners.values()]) {
        if (listener.filter(message as never)) listener.action(message as never);
      }
    });

    const messaging = new InProcessMessaging({ appId, instanceId }, server, instanceId, listeners, () => open);
    const heartbeat = new DefaultHeartbeatSupport(messaging);
    const channels = new DefaultChannelSupport(messaging, NO_UI, MESSAGE_TIMEOUT_MS);
    const intents = new DefaultIntentSupport(messaging, NO_UI, MESSAGE_TIMEOUT_MS, INTENT_TIMEOUT_MS);
    const apps = new DefaultAppSupport(messaging, MESSAGE_TIMEOUT_MS, INTENT_TIMEOUT_MS);
    // the proxy logs every message at its default level; warnings and errors are what a host wants
    const agent = new DesktopAgentProxy(heartbeat, channels, intents, apps, [heartbeat, channels, NO_UI, NO_UI], LogLevel.WARN);

    const release = () => {
      if (!open) return;
      open = false;
      listeners.clear();
      // terminates the instance and drops its listeners and channel membership on the agent side
      server.cleanup(instanceId);
    };
    signal.addEventListener('abort', release, { once: true });

    await agent.connect();
    if (signal.aborted) release();
    return agent;
  }

  return {
    async realmGlobals({ fragmentId, signal }) {
      if (signal.aborted || directory.retrieveAppsById(fragmentId).length === 0) return undefined;
      return { fdc3: await connect(fragmentId, signal) };
    },
  };
}

/** One app instance's side of the in-process transport. */
class InProcessMessaging extends AbstractMessaging {
  constructor(
    identity: AppIdentifier,
    private readonly server: FDC3Server,
    private readonly instanceId: InstanceID,
    private readonly listeners: Map<string, RegisterableListener>,
    private readonly isOpen: () => boolean,
  ) {
    super(identity);
  }

  createUUID(): string {
    return crypto.randomUUID();
  }

  async post(message: object): Promise<void> {
    if (!this.isOpen()) return;
    // a clone, as a MessagePort would make: neither side holds the other's objects
    await this.server.receive(structuredClone(message) as never, this.instanceId);
  }

  register(listener: RegisterableListener): void {
    if (listener.id) this.listeners.set(listener.id, listener);
  }

  unregister(id: string): void {
    this.listeners.delete(id);
  }

  createMeta() {
    return { requestUuid: this.createUUID(), timestamp: new Date(), source: this.getAppIdentifier() };
  }

  async disconnect(): Promise<void> {
    this.listeners.clear();
  }
}

/** The agent's view of the page: instances are connected fragments, and nothing is launched. */
class BraidServerContext implements ServerContext<AppRegistration> {
  /**
   * Registrations are plain data: the agent copies them into its responses (an intent's candidate
   * apps), so a delivery callback kept on one would be sent along with it.
   */
  private readonly instances = new Map<InstanceID, AppRegistration>();
  private readonly deliveries = new Map<InstanceID, (message: object) => void>();

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
    queueMicrotask(() => deliver(copy));
  }

  /**
   * Launching is the host's to do — mounting a `<fragment-slot>` — and is not wired yet, so
   * `fdc3.open` and an intent raised to an app with no live instance cannot start one.
   */
  async open(): Promise<InstanceID> {
    throw new Error(OpenError.ErrorOnLaunch);
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
   * Only live instances can take an intent, because nothing can be launched yet: a directory-only
   * candidate would send the raise to `open`. Dropping it here makes that a clean `NoAppsFound`.
   */
  async narrowIntents(_raiser: AppIdentifier, appIntents: AppIntent[]): Promise<AppIntent[]> {
    return appIntents
      .map((appIntent) => ({ ...appIntent, apps: appIntent.apps.filter((app) => app.instanceId !== undefined) }))
      .filter((appIntent) => appIntent.apps.length > 0);
  }
}
