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
import {
  ChannelError,
  CloseError,
  LogLevel,
  OpenError,
  ResolveError,
  type AppIdentifier,
  type AppIntent,
  type Context,
  type DesktopAgent,
  type IntentResolutionChoice,
} from '@finos/fdc3-standard';
import { dialogResolver } from './resolver.js';

/**
 * An FDC3 3.0 Desktop Agent for one Braid page.
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
 * - **Launching is mounting.** With a `container`, `fdc3.open` and intents for apps that are not
 *   running mount a `<fragment-slot>` there.
 *
 * That is all of it. What FDC3 does not standardize — remembered choices, preferences, per-app
 * settings, saved layouts — is not here: it is the workspace in `@braidlabs/console/workspace`,
 * which composes around this agent through `resolveIntent` and `realmGlobals`.
 */
export interface BraidDesktopAgentOptions {
  /**
   * The App Directory records the agent resolves against — the `applications` of a Braid AppD
   * listing (`createRegistryApi({ appd })` or the gateway's `discovery: { appd: true }`). Each
   * record's `appId` is a fragment id; a fragment with no record gets no `fdc3`, and neither does
   * one whose record's `fdc3Version` range excludes 3.0.
   */
  directory: readonly DirectoryApp[];
  /**
   * Where the agent mounts fragments it launches — for `fdc3.open`, and for an intent whose app is
   * not running. A `<fragment-slot>` the host places there itself counts as that app starting.
   * Without one nothing is launched: `fdc3.open` rejects with `ErrorOnLaunch`.
   *
   * A function is asked each time, for a container a framework renders after the agent is
   * created or replaces later; while it returns nothing, a launch is refused as if there were none.
   */
  container?: Element | (() => Element | null | undefined);
  /**
   * Chooses among the apps that can take an intent, when there is more than one. Defaults to a
   * built-in dialog in a browser; `false` refuses such a raise with `UserCancelledResolution`.
   */
  resolveIntent?: IntentResolverHook | false;
}

/** One app — a running instance, or the app itself to be launched — that can take an intent. */
export interface IntentCandidate {
  intent: string;
  appId: string;
  /** Set for a running instance; absent for the app itself, which choosing launches — or, when `starting`, waits for. */
  instanceId?: string;
  /** The app is open but not yet listening for the intent; choosing it waits for that instance rather than launching one. */
  starting?: true;
  /** The directory's title for the app, or its id. */
  title: string;
  /** The directory's first icon, if it has one. */
  icon?: string;
}

export interface IntentChoiceRequest {
  context: Context;
  raisedBy: AppIdentifier;
  /** Two or more, in the order the agent found them. */
  candidates: IntentCandidate[];
}

/**
 * Chooses for a raise: one of the candidates, or undefined to cancel. The agent keeps nothing, so
 * `remember` is for whatever wraps the hook — the console workspace's `intentResolver` stores the
 * choice and answers the next raise itself.
 */
export type IntentResolverHook = (
  request: IntentChoiceRequest,
) => Promise<{ candidate: IntentCandidate; remember?: boolean } | undefined>;

export interface BraidDesktopAgent {
  /**
   * The hook for `initBraid({ realmGlobals })`: a fragment in the directory gets `{ fdc3 }`, bound
   * to its id, before any of its code runs; its signal releases the instance.
   */
  realmGlobals(fragment: { fragmentId: string; signal: AbortSignal; slot?: Element }): Promise<{ fdc3: DesktopAgent } | undefined>;
}

/** The FDC3 version the agent implements; the directory drops records whose `fdc3Version` excludes it. */
const FDC3_VERSION = '3.0';
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

/** The proxy's channel selector, and its connectables, when the host supplies no UI. */
const NO_UI = {
  connect: async () => undefined,
  disconnect: async () => undefined,
  chooseIntent: async () => undefined,
  updateChannel: async () => undefined,
  setChannelChangeCallback: () => undefined,
};

/** What FINOS's IntentHandler keeps for an intent it holds until an app starts: the parts read here. */
interface HeldIntent {
  appId?: { appId: string; instanceId?: string };
  r?: { from?: { instanceId?: string }; intent?: unknown; context?: { type?: unknown }; newInstance?: unknown };
}

/** What a slot the agent mounted is for, until its fragment connects. */
interface Launch {
  instanceId: string;
}

export function createBraidDesktopAgent(options: BraidDesktopAgentOptions): BraidDesktopAgent {
  // a directory that failed to load is an empty one, not a page that fails to compose
  const records = Array.isArray(options.directory) ? [...options.directory] : [];
  const directory = new BasicDirectory(records, FDC3_VERSION);
  /** The container now: the one given, or whatever the host's function finds at this moment. */
  const containerNow = (): Element | undefined =>
    (typeof options.container === 'function' ? options.container() : options.container) ?? undefined;
  const canLaunch = options.container !== undefined;
  const resolveIntent =
    options.resolveIntent === false
      ? undefined
      : (options.resolveIntent ?? (typeof document === 'undefined' ? undefined : dialogResolver(document)));

  /** Slots the agent mounted, until their fragment connects. */
  const launches = new WeakMap<Element, Launch>();
  /** Connected fragments' instance ids, by the slot they boot in. */
  const bySlot = new Map<Element, InstanceID>();

  const context: BraidServerContext = new BraidServerContext(taskQueue(), (appId: string): InstanceID | undefined => {
    const container = containerNow();
    if (!container) return undefined;
    const instanceId = crypto.randomUUID();
    mountSlot(container, appId, (slot) => launches.set(slot, { instanceId }));
    return instanceId;
  });
  context.launchable = canLaunch;
  context.knows = (appId) => directory.retrieveAppsById(appId).length > 0;
  // a slot in the container that has not connected yet: launched by the agent, or placed by the host
  context.mounting = (appId) => {
    const container = containerNow();
    if (!container) return undefined;
    for (const slot of slotsIn(container)) {
      if (slot.getAttribute('name') !== appId || bySlot.has(slot)) continue;
      let launch = launches.get(slot);
      if (!launch) launches.set(slot, (launch = { instanceId: crypto.randomUUID() }));
      return launch.instanceId;
    }
    return undefined;
  };
  const userChannels: ChannelState[] = USER_CHANNELS.map(([color, glyph]) => ({
    id: `fdc3.channel.${glyph}`,
    type: ChannelType.user,
    context: [],
    displayMetadata: { name: `Channel ${glyph}`, color, glyph },
  }));
  const server = new DefaultFDC3Server(context, directory, userChannels, false, INTENT_TIMEOUT_MS, MESSAGE_TIMEOUT_MS);
  // which instances are listening for what: the agent's intent handler is the source of truth
  const intentHandler = server.handlers.find((handler): handler is IntentHandler => handler instanceof IntentHandler);
  context.hasListener = (instanceId, intent, contextType) => intentHandler?.hasListener(instanceId, intent, contextType) ?? false;
  context.heldIntents = () => (intentHandler as unknown as { pendingIntents?: Set<HeldIntent> } | undefined)?.pendingIntents ?? new Set();

  /** The candidates for a raise, as the resolver sees them. */
  function candidatesOf(appIntents: AppIntent[]): IntentCandidate[] {
    return appIntents.flatMap((appIntent) =>
      appIntent.apps.map((app) => {
        const record = directory.retrieveAppsById(app.appId)[0];
        const icon = record?.icons?.[0]?.src;
        return {
          intent: appIntent.intent.name,
          appId: app.appId,
          ...(app.instanceId
            ? { instanceId: app.instanceId }
            : (app.instanceMetadata as { braidStarting?: unknown } | undefined)?.braidStarting === true
              ? { starting: true as const }
              : {}),
          title: record?.title ?? app.appId,
          ...(icon ? { icon } : {}),
        };
      }),
    );
  }

  /** The proxy's intent resolver for one instance: the only candidate, or the host's choice among several. */
  async function choose(raisedBy: AppIdentifier, appIntents: AppIntent[], raised: Context): Promise<IntentResolutionChoice | undefined> {
    const candidates = candidatesOf(appIntents);
    let choice = candidates.length === 1 ? candidates[0] : undefined;
    if (!choice && candidates.length > 1 && resolveIntent) {
      // a resolver that throws has chosen nothing
      const answer = await resolveIntent({ context: raised, raisedBy, candidates: candidates.map((candidate) => ({ ...candidate })) }).catch(
        () => undefined,
      );
      // only one of what was offered: a resolver cannot route the intent anywhere else
      choice = answer && candidates.find((candidate) => sameCandidate(candidate, answer.candidate));
    }
    if (!choice) return undefined;
    return {
      intent: choice.intent,
      appId: choice.instanceId ? { appId: choice.appId, instanceId: choice.instanceId } : { appId: choice.appId },
    };
  }

  async function connect(
    appId: string,
    signal: AbortSignal,
    slot: Element | undefined,
  ): Promise<{ fdc3: DesktopAgent } | undefined> {
    // kept until the connect succeeds: a boot cut short and retried connects as the same launch
    const launch = slot ? launches.get(slot) : undefined;
    const instanceId = launch?.instanceId ?? context.createUUID();
    let open = true;

    // A fragment holds its `fdc3` and everything reachable from it. The server — and through it
    // every other instance — is reachable only through this closure, never as a property, so a
    // fragment can speak only as itself.
    const messaging = new InProcessMessaging(
      { appId, instanceId },
      (message) => server.receive(context.inspect(message, instanceId) as never, instanceId),
      () => open,
      canLaunch,
    );
    context.setInstanceDetails(instanceId, { appId, instanceId, state: State.Connected });
    context.onMessage(instanceId, (message) => {
      if (open) messaging.deliver(message);
    });

    const identity = { appId, instanceId };
    const resolver = { ...NO_UI, chooseIntent: (appIntents: AppIntent[], raised: Context) => choose(identity, appIntents, raised) };
    const heartbeat = new DefaultHeartbeatSupport(messaging);
    const channels = new DefaultChannelSupport(messaging, NO_UI, MESSAGE_TIMEOUT_MS);
    const intents = new DefaultIntentSupport(messaging, resolver, MESSAGE_TIMEOUT_MS, INTENT_TIMEOUT_MS);
    const apps = new DefaultAppSupport(messaging, MESSAGE_TIMEOUT_MS, INTENT_TIMEOUT_MS);
    // the proxy logs every message at its default level; warnings and errors are what a host wants
    const agent = new DesktopAgentProxy(heartbeat, channels, intents, apps, [heartbeat, channels, NO_UI, NO_UI], LogLevel.WARN);

    const release = () => {
      if (!open) return;
      open = false;
      if (slot && bySlot.get(slot) === instanceId) bySlot.delete(slot);
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
    // A launched app is one FINOS is waiting for: an open to answer, or an intent to deliver. It
    // learns of the arrival from the Web Connection Protocol's identity check, so the instance
    // announces itself with one — before the fragment has its `fdc3`, so the context listener it
    // adds next finds FINOS ready to deliver the open's context to it.
    if (launch) await context.announce(server, instanceId);
    // held intents tied to an instance of this app that is gone are this one's now
    const container = containerNow();
    if (container) context.adopt(appId, instanceId, (id) => slotsIn(container).some((other) => launches.get(other)?.instanceId === id));
    if (signal.aborted) return undefined;
    if (slot) {
      launches.delete(slot);
      bySlot.set(slot, instanceId);
    }
    return { fdc3: agent };
  }

  return {
    async realmGlobals({ fragmentId, signal, slot }) {
      if (signal.aborted || directory.retrieveAppsById(fragmentId).length === 0) return undefined;
      return connect(fragmentId, signal, slot);
    },
  };
}

/** The `<fragment-slot>` children of a container, in document order. */
function slotsIn(container: Element): Element[] {
  return [...container.children].filter((child) => child.localName === 'fragment-slot');
}

/**
 * Mounts a `<fragment-slot>` for an app at the end of `container`. `prepare` runs before the slot
 * connects — which is when it boots and its fragment asks for its globals.
 */
function mountSlot(container: Element, appId: string, prepare?: (slot: Element) => void): Element {
  const slot = container.ownerDocument.createElement('fragment-slot');
  slot.setAttribute('name', appId);
  prepare?.(slot);
  container.append(slot);
  return slot;
}

function sameCandidate(a: IntentCandidate, b: IntentCandidate | undefined): boolean {
  return !!b && a.intent === b.intent && a.appId === b.appId && (a.instanceId ?? null) === (b.instanceId ?? null);
}

/**
 * One app instance's side of the in-process transport. State is in `#private` fields, which a
 * fragment cannot read through the proxy that holds this.
 */
class InProcessMessaging extends AbstractMessaging {
  readonly #send: (message: object) => Promise<void>;
  readonly #isOpen: () => boolean;
  readonly #canLaunch: boolean;
  readonly #listeners = new Map<string, RegisterableListener>();
  /** Requests sent and not yet answered, by request id. */
  readonly #inFlight = new Map<string, object>();

  constructor(identity: AppIdentifier, send: (message: object) => Promise<void>, isOpen: () => boolean, canLaunch: boolean) {
    super(identity);
    this.#send = send;
    this.#isOpen = isOpen;
    this.#canLaunch = canLaunch;
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
    // without a container nothing can be launched: neither `open` nor a raise that asks for a new
    // instance (the agent would hand that to the instance already running)
    const { type: kind, payload: request } = message as { type?: unknown; payload?: { newInstance?: unknown } };
    if (!this.#canLaunch) {
      if (kind === 'openRequest') return this.#refuse(message, OpenError.ErrorOnLaunch);
      if ((kind === 'raiseIntentRequest' || kind === 'raiseIntentForContextRequest') && request?.newInstance === true) {
        return this.#refuse(message, ResolveError.TargetAppUnavailable);
      }
    }
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

/**
 * The agent's view of the page: instances are connected fragments, and launching one is the
 * `launch` callback's — mounting a slot — when the host gave a container.
 */
class BraidServerContext implements ServerContext<AppRegistration> {
  /**
   * Registrations are plain data: the agent copies them into its responses (an intent's candidate
   * apps), so a delivery callback kept on one would be sent along with it.
   */
  private readonly instances = new Map<InstanceID, AppRegistration>();
  private readonly deliveries = new Map<InstanceID, (message: object) => void>();
  /**
   * Raises in progress that asked for a new instance, noted by {@link inspect} for
   * {@link narrowIntents}, which has no other way to tell; dropped after a task.
   */
  private readonly newInstance: { from: InstanceID; intent?: string; contextType?: string }[] = [];

  constructor(
    private readonly schedule: (task: () => void) => void,
    /** Mounts a new instance of the app, returning the instance id it will connect as; undefined if nothing can be launched. */
    private readonly launch: (appId: string) => InstanceID | undefined,
  ) {}

  /** Whether an instance has an intent listener for `intent` (and `contextType`, if given); set by the agent. */
  hasListener: (instanceId: InstanceID, intent: string, contextType?: string) => boolean = () => false;

  /** Live instances of an app, oldest first. */
  private live(appId: string): AppRegistration[] {
    return [...this.instances.values()].filter((instance) => instance.appId === appId && instance.state === State.Connected);
  }

  /** Set when the host gave a container. */
  launchable = false;

  /**
   * A mounted instance of the app that has not connected yet — one the agent launched, or a slot
   * the host placed in the container — as the instance id it will connect as. Set by the agent.
   */
  mounting: (appId: string) => InstanceID | undefined = () => undefined;

  /** The app has an instance that will be able to take an intent, but none listening for it yet. */
  private booting(appId: string): boolean {
    return this.live(appId).length > 0 || this.mounting(appId) !== undefined;
  }

  /** Adds `note` to `list` for one task. */
  private static hold<T>(list: T[], note: T): void {
    list.push(note);
    setTimeout(() => {
      const index = list.indexOf(note);
      if (index >= 0) list.splice(index, 1);
    }, 0);
  }



  /**
   * Looks at a request on its way to the agent, and returns what the agent should get:
   *
   * - A raise that names an app but no instance is resolved here to the instance that will take
   *   it: the one listening for the intent, or — when none is yet — the app's only instance, so
   *   the agent holds the intent until that fragment's listener arrives. FINOS would otherwise
   *   treat it as a request to launch the app. A raise asking for a new instance is left alone.
   * - A raise asking for a new instance is noted, so {@link narrowIntents} offers it launches.
   */
  inspect(message: object, from: InstanceID): object {
    const { type, payload } = message as {
      type?: unknown;
      payload?: {
        intent?: unknown;
        newInstance?: unknown;
        context?: { type?: unknown };
        app?: { appId?: unknown; instanceId?: unknown };
      };
    };
    if (type !== 'raiseIntentRequest' && type !== 'raiseIntentForContextRequest') return message;
    if (payload?.newInstance === true) {
      BraidServerContext.hold(this.newInstance, {
        from,
        ...(typeof payload.intent === 'string' ? { intent: payload.intent } : {}),
        ...(typeof payload.context?.type === 'string' ? { contextType: payload.context.type } : {}),
      });
      return message;
    }
    const app = payload?.app;
    if (type !== 'raiseIntentRequest' || typeof payload?.intent !== 'string' || typeof app?.appId !== 'string' || app.instanceId) {
      return message;
    }
    const live = this.live(app.appId);
    const contextType = typeof payload.context?.type === 'string' ? payload.context.type : undefined;
    const listening = live.filter((instance) => this.hasListener(instance.instanceId, payload.intent as string, contextType));
    const target = listening.length === 1 ? listening[0] : listening.length === 0 && live.length === 1 ? live[0] : undefined;
    return target ? { ...message, payload: { ...payload, app: { appId: target.appId, instanceId: target.instanceId } } } : message;
  }

  /**
   * Tells FINOS a launched instance has arrived, with the Web Connection Protocol identity check
   * it would otherwise wait for. Its answer, addressed to the instance, is ignored there.
   */
  async announce(server: { receive(message: never, from: InstanceID): Promise<void> }, instanceId: InstanceID): Promise<void> {
    await server.receive(
      { type: 'WCP4ValidateAppIdentity', meta: { connectionAttemptUuid: this.createUUID(), timestamp: new Date() }, payload: {} } as never,
      instanceId,
    );
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
   * Called for `fdc3.open`, and when FINOS holds an intent for an app to start. FINOS adds the held
   * intent and calls this in one step, so the newest held intent for the app from this raiser that
   * is not yet tied to an instance is that raise's — and none means `fdc3.open`.
   *
   * - `fdc3.open` launches. An app the directory does not know rejects with `AppNotFound`, which
   *   FINOS answers the open with.
   * - A held intent launches when its raise asked for a new instance. Otherwise it waits for an
   *   instance that is booting — connected but not listening for it, or mounted and not yet
   *   connected, including one an earlier raise just launched — and launches only when there is
   *   none; deciding here, when the launch would happen, keeps two quick raises from mounting the
   *   app twice.
   *
   * Either way the held intent is then tied to that instance (see {@link adopt}): FINOS holds it
   * for "any instance of the app" and drops the id returned here, so otherwise whichever instance
   * added a listener first would take it.
   */
  async open(appId: string, from?: AppRegistration): Promise<InstanceID> {
    if (!this.launchable) return this.live(appId)[0]?.instanceId ?? this.createUUID();
    const raiser = from?.instanceId;
    const held = [...this.heldIntents()]
      .reverse()
      .find((intent) => intent.appId?.appId === appId && intent.appId.instanceId === undefined && intent.r?.from?.instanceId === raiser);
    // a string the directory has: anything else is refused before a slot is mounted for it
    const known = typeof appId === 'string' && this.knows(appId);
    if (!held) {
      if (!known) throw new Error(OpenError.AppNotFound);
      // a container that is not on the page right now: refused, rather than an open that waits out its timeout
      const launched = this.launch(appId);
      if (!launched) throw new Error(OpenError.ErrorOnLaunch);
      return launched;
    }
    if (!known) return this.createUUID();
    const request = held.r ?? {};
    const contextType = typeof request.context?.type === 'string' ? request.context.type : undefined;
    const booting =
      request.newInstance === true
        ? undefined
        : (this.live(appId).find((instance) => !this.hasListener(instance.instanceId, String(request.intent), contextType))?.instanceId ??
          this.mounting(appId));
    const instanceId = booting ?? this.launch(appId);
    if (!instanceId) return this.createUUID();
    held.appId = { appId, instanceId };
    return instanceId;
  }

  /** Whether the directory has the app; set by the agent. */
  knows: (appId: string) => boolean = () => false;

  /** The intents FINOS is holding for an app to start; set by the agent from its intent handler. */
  heldIntents: () => Set<HeldIntent> = () => new Set();

  /**
   * A new instance of `appId` takes over the held intents tied to an instance of that app that is
   * gone — torn down, or its slot removed before it connected (a restore replaces slots) — so they
   * reach the instance that replaced it rather than waiting out their timeout. `pending` says which
   * not-yet-connected instance ids still have a slot.
   */
  adopt(appId: string, instanceId: InstanceID, pending: (id: InstanceID) => boolean): void {
    for (const held of this.heldIntents()) {
      const tied = held.appId?.instanceId;
      if (held.appId?.appId !== appId || tied === undefined || tied === instanceId) continue;
      if (this.instances.get(tied)?.state === State.Connected || pending(tied)) continue;
      held.appId = { appId, instanceId };
    }
  }

  /**
   * `fdc3.close()`, refused: fragments are torn down by their host, not by the agent. The agent
   * answers a close only when this throws, so a no-op would leave the app waiting out its timeout.
   */
  async close(): Promise<void> {
    throw new Error(CloseError.ErrorOnClose);
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
    return FDC3_VERSION;
  }

  /**
   * The candidates an intent may go to:
   *
   * - an instance only once it listens for the intent, for this context's type — before then,
   *   sending it the intent would lose it;
   * - an app without an instance (the directory's entry) while one is booting — connected, or
   *   mounted and not yet connected — and none listens yet: the agent then holds the intent until
   *   the listener arrives, and {@link open} hands it that instance rather than launching another;
   * - with a container, an app the directory names for the intent that has no instance listening
   *   or booting, which choosing launches. A raise that asked for a new instance launches even
   *   when one is booting.
   *
   * Without a container, an app with no live instance drops out, which makes the raise a clean
   * `NoAppsFound`.
   */
  async narrowIntents(raiser: AppIdentifier, appIntents: AppIntent[], context?: Context): Promise<AppIntent[]> {
    // a raise for a new instance is not held for a booting one; open() takes the note when it launches
    const fresh = this.newInstance.some(
      (note) =>
        note.from === raiser.instanceId &&
        (note.contextType ?? 'fdc3.nothing') === (context?.type ?? 'fdc3.nothing') &&
        (note.intent === undefined || appIntents.some((appIntent) => appIntent.intent.name === note.intent)),
    );
    const narrowed = appIntents
      .map((appIntent) => {
        // a raise for a new instance is offered launches only: every app the directory names for it
        const listening = fresh
          ? []
          : appIntent.apps.filter(
              (app) => app.instanceId !== undefined && this.hasListener(app.instanceId, appIntent.intent.name, context?.type),
            );
        const listens = (appId: string) => listening.some((candidate) => candidate.appId === appId);
        const entries = appIntent.apps.filter((app) => app.instanceId === undefined && !listens(app.appId));
        const waiting = fresh ? [] : entries.filter((app) => this.booting(app.appId));
        // launching is for an app nothing running or booting can take the intent for
        const launches = this.launchable ? entries.filter((app) => !waiting.includes(app)) : [];
        // marked, so the resolver can say choosing it waits rather than launches
        const marked = waiting.map((app) => ({ ...app, instanceMetadata: { ...app.instanceMetadata, braidStarting: true } }));
        return { ...appIntent, apps: [...listening, ...marked, ...launches] };
      })
      .filter((appIntent) => appIntent.apps.length > 0);
    return narrowed;
  }
}
