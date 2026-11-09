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
import { keySegment, localStorageStore, type PreferenceStore } from './store.js';

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
   * Where the agent mounts fragments it launches — for `fdc3.open`, for an intent whose app is
   * not running, and for a restored layout — and the `<fragment-slot>`s a saved layout records.
   * Without one nothing is launched: `fdc3.open` rejects with `ErrorOnLaunch`, as before.
   */
  container?: Element;
  /**
   * Where the user's preferences, app settings and layouts are kept. Defaults to
   * {@link localStorageStore}; {@link serverStore} keeps them on the gateway, per signed-in user.
   */
  store?: PreferenceStore;
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
  /** Set for a running instance; absent for the app, which choosing launches. */
  instanceId?: string;
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
 * Chooses for a raise: one of the candidates, with `remember: true` to choose that app for this
 * intent and context type from now on, or undefined to cancel.
 */
export type IntentResolverHook = (
  request: IntentChoiceRequest,
) => Promise<{ candidate: IntentCandidate; remember?: boolean } | undefined>;

/** The user's preferences for the whole page. */
export interface HostPreferences {
  /** A user channel id (`fdc3.channel.1`…`8`) every fragment joins before its code runs. */
  defaultUserChannel?: string;
  /** App ids never offered as a choice when resolving an intent. */
  hiddenApps?: string[];
}

/** What {@link BraidDesktopAgent.layouts} saves: the container's slots, in order. */
export interface SavedLayout {
  version: 1;
  savedAt: string;
  slots: SavedSlot[];
}

export interface SavedSlot {
  appId: string;
  src?: string;
  props?: Record<string, unknown>;
  /** The user channel the instance was on. */
  channel?: string;
  /** What the app returned from `braidDesktop.onSaveLayout`. */
  state?: unknown;
}

/**
 * Braid's additions for one fragment, as `window.braidDesktop`, alongside its `fdc3`.
 */
export interface BraidDesktopApi {
  /** This app's settings for the signed-in user: shared by its instances, apart from other apps'. */
  settings: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  /** Supplies this instance's state when the page's layout is saved; it must be JSON. Returns an unsubscribe. */
  onSaveLayout(handler: () => unknown): () => void;
  /** The state this instance saved, when it was mounted by restoring a layout; otherwise undefined. */
  readonly restoredState: unknown;
}

export interface BraidDesktopAgent {
  /**
   * The hook for `initBraid({ realmGlobals })`: a fragment in the directory gets `{ fdc3,
   * braidDesktop }`, bound to its id, before any of its code runs; its signal releases the instance.
   */
  realmGlobals(fragment: {
    fragmentId: string;
    signal: AbortSignal;
    slot?: Element;
  }): Promise<{ fdc3: DesktopAgent; braidDesktop: BraidDesktopApi } | undefined>;
  preferences: {
    getHost(): Promise<HostPreferences>;
    /** Replaces the page's preferences; fragments that connect from now on get them. */
    setHost(preferences: HostPreferences): Promise<void>;
    /** The app remembered for an intent and context type, if any. */
    intentChoice(intent: string, contextType: string): Promise<string | undefined>;
    forgetIntentChoice(intent: string, contextType: string): Promise<void>;
  };
  /** Saved layouts of the `container`. Each needs a `container`. */
  layouts: {
    save(name: string): Promise<SavedLayout>;
    /** Replaces the container's slots with the saved ones. Rejects if there is no such layout. */
    restore(name: string): Promise<void>;
    list(): Promise<string[]>;
    delete(name: string): Promise<void>;
  };
}

/** The FDC3 version the agent implements; the directory drops records whose `fdc3Version` excludes it. */
const FDC3_VERSION = '3.0';
/** A request is answered within this, or the proxy reports `ApiTimeout`. */
const MESSAGE_TIMEOUT_MS = 10_000;
/** How long a raised intent may take to be handled. */
const INTENT_TIMEOUT_MS = 20_000;
/** How long saving a layout waits for each app's state. */
const SAVE_STATE_TIMEOUT_MS = 2_000;

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

const HOST_KEY = 'host';
const intentKey = (intent: string, contextType: string) => `intents/${keySegment(intent)}/${keySegment(contextType)}`;
const layoutKey = (name: string) => `layouts/${keySegment(name)}`;
const appPrefix = (appId: string) => `apps/${keySegment(appId)}/`;

/** One connected fragment, as the agent's host side sees it. */
interface Instance {
  appId: string;
  instanceId: string;
  fdc3: DesktopAgent;
  saveHandlers: Set<() => unknown>;
}

/** What a slot the agent mounted is for, until its fragment connects. */
interface Launch {
  instanceId: string;
  restore?: { channel?: string; state?: unknown };
}

export function createBraidDesktopAgent(options: BraidDesktopAgentOptions): BraidDesktopAgent {
  // a directory that failed to load is an empty one, not a page that fails to compose
  const records = Array.isArray(options.directory) ? [...options.directory] : [];
  const directory = new BasicDirectory(records, FDC3_VERSION);
  const { container } = options;
  const store = options.store ?? localStorageStore();
  const resolveIntent =
    options.resolveIntent === false
      ? undefined
      : (options.resolveIntent ?? (typeof document === 'undefined' ? undefined : dialogResolver(document)));

  /** Slots the agent mounted, until their fragment connects. */
  const launches = new WeakMap<Element, Launch>();
  /** Connected fragments, by the slot they boot in. */
  const bySlot = new Map<Element, Instance>();

  const context: BraidServerContext = new BraidServerContext(taskQueue(), (appId: string): InstanceID | undefined => {
    if (!container) return undefined;
    const instanceId = crypto.randomUUID();
    mountSlot(container, { appId }, (slot) => launches.set(slot, { instanceId }));
    return instanceId;
  });
  context.launchable = container !== undefined;
  context.knows = (appId) => directory.retrieveAppsById(appId).length > 0;
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

  async function hostPreferences(): Promise<HostPreferences> {
    try {
      const stored = await store.get(HOST_KEY);
      return stored && typeof stored === 'object' ? (stored as HostPreferences) : {};
    } catch {
      // preferences that cannot be read are no preferences, not a fragment that fails to connect
      return {};
    }
  }

  /** The candidates for a raise, as the resolver sees them; hidden apps left out. */
  function candidatesOf(appIntents: AppIntent[], hidden: readonly string[]): IntentCandidate[] {
    return appIntents.flatMap((appIntent) =>
      appIntent.apps
        .filter((app) => !hidden.includes(app.appId))
        .map((app) => {
          const record = directory.retrieveAppsById(app.appId)[0];
          const icon = record?.icons?.[0]?.src;
          return {
            intent: appIntent.intent.name,
            appId: app.appId,
            ...(app.instanceId ? { instanceId: app.instanceId } : {}),
            title: record?.title ?? app.appId,
            ...(icon ? { icon } : {}),
          };
        }),
    );
  }

  /**
   * The remembered app's candidate: its one running instance, or the app itself when it is not
   * running. Anything else — two instances, or the app no longer a candidate — is the user's call.
   */
  async function remembered(candidates: IntentCandidate[], contextType: string): Promise<IntentCandidate | undefined> {
    const matches: IntentCandidate[] = [];
    for (const intent of new Set(candidates.map((candidate) => candidate.intent))) {
      let appId: unknown;
      try {
        appId = (await store.get(intentKey(intent, contextType)) as { appId?: unknown } | undefined)?.appId;
      } catch {
        continue;
      }
      const ofApp = candidates.filter((candidate) => candidate.intent === intent && candidate.appId === appId);
      const running = ofApp.filter((candidate) => candidate.instanceId);
      const pick = running.length === 1 ? running[0] : running.length === 0 && ofApp.length === 1 ? ofApp[0] : undefined;
      if (pick) matches.push(pick);
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** The proxy's intent resolver for one instance: hidden apps, then a remembered choice, then the user. */
  async function choose(raisedBy: AppIdentifier, appIntents: AppIntent[], raised: Context): Promise<IntentResolutionChoice | undefined> {
    const { hiddenApps = [] } = await hostPreferences();
    const candidates = candidatesOf(appIntents, Array.isArray(hiddenApps) ? hiddenApps : []);
    const contextType = typeof raised?.type === 'string' ? raised.type : 'fdc3.nothing';
    let choice = candidates.length === 1 ? candidates[0] : await remembered(candidates, contextType);
    if (!choice && candidates.length > 1 && resolveIntent) {
      const answer = await resolveIntent({ context: raised, raisedBy, candidates: candidates.map((candidate) => ({ ...candidate })) });
      // only one of what was offered: a resolver cannot route the intent anywhere else
      const offered = answer && candidates.find((candidate) => sameCandidate(candidate, answer.candidate));
      if (offered) {
        choice = offered;
        if (answer.remember) await store.set(intentKey(offered.intent, contextType), { appId: offered.appId }).catch(() => undefined);
      }
    }
    if (!choice) return undefined;
    return {
      intent: choice.intent,
      appId: choice.instanceId ? { appId: choice.appId, instanceId: choice.instanceId } : { appId: choice.appId },
    };
  }

  function braidDesktopFor(appId: string, instance: Instance, restoredState: unknown): BraidDesktopApi {
    const prefix = appPrefix(appId);
    return Object.freeze({
      settings: Object.freeze({
        get: (key: string) => store.get(prefix + keySegment(String(key))),
        set: (key: string, value: unknown) => store.set(prefix + keySegment(String(key)), value),
        delete: (key: string) => store.delete(prefix + keySegment(String(key))),
        keys: async () => (await store.list(prefix)).map((key) => decodeURIComponent(key.slice(prefix.length))),
      }),
      onSaveLayout(handler: () => unknown) {
        if (typeof handler !== 'function') throw new TypeError('braidDesktop.onSaveLayout takes a function');
        instance.saveHandlers.add(handler);
        return () => void instance.saveHandlers.delete(handler);
      },
      restoredState: restoredState === undefined ? undefined : structuredClone(restoredState),
    });
  }

  async function connect(
    appId: string,
    signal: AbortSignal,
    slot: Element | undefined,
  ): Promise<{ fdc3: DesktopAgent; braidDesktop: BraidDesktopApi } | undefined> {
    const launch = slot ? launches.get(slot) : undefined;
    if (slot) launches.delete(slot);
    const instanceId = launch?.instanceId ?? context.createUUID();
    let open = true;

    // A fragment holds its `fdc3` and everything reachable from it. The server — and through it
    // every other instance — is reachable only through this closure, never as a property, so a
    // fragment can speak only as itself.
    const messaging = new InProcessMessaging(
      { appId, instanceId },
      (message) => server.receive(context.inspect(message, instanceId) as never, instanceId),
      () => open,
      container !== undefined,
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
    const instance: Instance = { appId, instanceId, fdc3: agent, saveHandlers: new Set() };

    const release = () => {
      if (!open) return;
      open = false;
      if (slot && bySlot.get(slot) === instance) bySlot.delete(slot);
      // terminates the instance and drops its listeners and channel membership on the agent side
      server.cleanup(instanceId);
      // the agent will not answer what was in flight, so answer it here
      messaging.refuseInFlight();
    };
    signal.addEventListener('abort', release, { once: true });

    try {
      // a teardown during connect refuses its requests at once (see `post`), so this settles promptly
      await agent.connect();
      const channel = launch?.restore?.channel ?? (await hostPreferences()).defaultUserChannel;
      if (typeof channel === 'string') await agent.joinUserChannel(channel).catch(() => undefined);
    } catch {
      release();
      return undefined;
    }
    // A launched app is one FINOS is waiting for: an open to answer, or an intent to deliver. It
    // learns of the arrival from the Web Connection Protocol's identity check, so the instance
    // announces itself with one — before the fragment has its `fdc3`, so the context listener it
    // adds next finds FINOS ready to deliver the open's context to it.
    if (launch) await context.announce(server, instanceId);
    if (signal.aborted) return undefined;
    if (slot) bySlot.set(slot, instance);
    return { fdc3: agent, braidDesktop: braidDesktopFor(appId, instance, launch?.restore?.state) };
  }

  function needContainer(): Element {
    if (!container) throw new Error('braid-fdc3: layouts need a container (createBraidDesktopAgent({ container }))');
    return container;
  }

  /** The state an instance gives for a layout: JSON, within the timeout, or nothing. */
  async function stateOf(instance: Instance | undefined): Promise<unknown> {
    const handler = instance && [...instance.saveHandlers].at(-1);
    if (!handler) return undefined;
    try {
      const state = await Promise.race([
        Promise.resolve().then(handler),
        new Promise((resolve) => setTimeout(resolve, SAVE_STATE_TIMEOUT_MS, undefined)),
      ]);
      return state === undefined ? undefined : JSON.parse(JSON.stringify(state));
    } catch {
      return undefined;
    }
  }

  return {
    async realmGlobals({ fragmentId, signal, slot }) {
      if (signal.aborted || directory.retrieveAppsById(fragmentId).length === 0) return undefined;
      return connect(fragmentId, signal, slot);
    },

    preferences: {
      getHost: hostPreferences,
      async setHost(preferences) {
        await store.set(HOST_KEY, preferences ?? {});
      },
      async intentChoice(intent, contextType) {
        const stored = (await store.get(intentKey(intent, contextType))) as { appId?: unknown } | undefined;
        return typeof stored?.appId === 'string' ? stored.appId : undefined;
      },
      async forgetIntentChoice(intent, contextType) {
        await store.delete(intentKey(intent, contextType));
      },
    },

    layouts: {
      async save(name) {
        const slots: SavedSlot[] = [];
        for (const slot of slotsIn(needContainer())) {
          const appId = slot.getAttribute('name');
          if (!appId) continue;
          const instance = bySlot.get(slot);
          const saved: SavedSlot = { appId };
          const src = slot.getAttribute('src');
          if (src !== null) saved.src = src;
          const props = (slot as Element & { props?: Record<string, unknown> }).props;
          if (props && typeof props === 'object' && Object.keys(props).length > 0) saved.props = JSON.parse(JSON.stringify(props));
          const channel = instance ? await instance.fdc3.getCurrentChannel().catch(() => null) : null;
          if (channel?.type === 'user') saved.channel = channel.id;
          const state = await stateOf(instance);
          if (state !== undefined) saved.state = state;
          slots.push(saved);
        }
        const layout: SavedLayout = { version: 1, savedAt: new Date().toISOString(), slots };
        await store.set(layoutKey(name), layout);
        return layout;
      },

      async restore(name) {
        const target = needContainer();
        const layout = (await store.get(layoutKey(name))) as SavedLayout | undefined;
        if (!layout || layout.version !== 1 || !Array.isArray(layout.slots)) {
          throw new Error(`braid-fdc3: no saved layout "${name}"`);
        }
        for (const slot of slotsIn(target)) slot.remove();
        for (const saved of layout.slots) {
          if (typeof saved?.appId !== 'string' || directory.retrieveAppsById(saved.appId).length === 0) continue;
          mountSlot(target, saved, (slot) =>
            launches.set(slot, { instanceId: context.createUUID(), restore: { channel: saved.channel, state: saved.state } }),
          );
        }
      },

      async list() {
        return (await store.list('layouts/')).map((key) => decodeURIComponent(key.slice('layouts/'.length)));
      },

      async delete(name) {
        await store.delete(layoutKey(name));
      },
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
function mountSlot(
  container: Element,
  app: { appId: string; src?: string; props?: Record<string, unknown> },
  prepare?: (slot: Element) => void,
): Element {
  const slot = container.ownerDocument.createElement('fragment-slot');
  slot.setAttribute('name', app.appId);
  if (typeof app.src === 'string') slot.setAttribute('src', app.src);
  if (app.props && typeof app.props === 'object') slot.setAttribute('props', JSON.stringify(app.props));
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
   * Apps whose booting instance should take an intent the agent is about to hold, by raiser — set
   * by {@link narrowIntents} and read by {@link open} within the same raise. Cleared after a task,
   * which is after every continuation of that raise has run.
   */
  private readonly reuse = new Map<InstanceID, Set<string>>();
  /** Raisers whose raise in progress asked for a new instance; cleared after a task, likewise. */
  private readonly newInstance = new Set<InstanceID>();

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
   * Looks at a request on its way to the agent, and returns what the agent should get:
   *
   * - A raise that names an app but no instance is resolved here to the instance that will take
   *   it: the one listening for the intent, or — when none is yet — the app's only instance, so
   *   the agent holds the intent until that fragment's listener arrives. FINOS would otherwise
   *   treat it as a request to launch the app. A raise asking for a new instance is left alone.
   * - A raise asking for a new instance is noted, so {@link narrowIntents} offers only launches.
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
      this.newInstance.add(from);
      setTimeout(() => this.newInstance.delete(from), 0);
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
   * Called for `fdc3.open`, and when the agent holds an intent for an app that has no instance
   * listening. If the raise found the app mounted and still booting (see {@link narrowIntents}),
   * that instance is the one it waits for; otherwise a new one is launched. An app the directory
   * does not know rejects with `AppNotFound` — only `fdc3.open` can ask for one, and it answers a
   * rejection; the intent path never sees one.
   */
  async open(appId: string, from?: AppRegistration): Promise<InstanceID> {
    const booting = from ? this.reuse.get(from.instanceId) : undefined;
    if (booting?.has(appId) || !this.launchable) {
      booting?.delete(appId);
      return this.live(appId)[0]?.instanceId ?? this.createUUID();
    }
    if (!this.knows(appId)) throw new Error(OpenError.AppNotFound);
    return this.launch(appId) ?? this.createUUID();
  }

  /** Whether the directory has the app; set by the agent. */
  knows: (appId: string) => boolean = () => false;

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
   * - an app without an instance (the directory's entry) while one is mounted and none of its
   *   instances listens yet — the agent then holds the intent until the listener arrives, and
   *   {@link open} hands it that instance;
   * - with a container, any other app the directory names for the intent, which choosing launches.
   *   A raise that asked for a new instance gets only these.
   *
   * Without a container, an app with no live instance drops out, which makes the raise a clean
   * `NoAppsFound`.
   */
  async narrowIntents(raiser: AppIdentifier, appIntents: AppIntent[], context?: Context): Promise<AppIntent[]> {
    const raiserId = raiser.instanceId;
    const fresh = raiserId !== undefined && this.newInstance.has(raiserId);
    const booting = new Set<string>();
    const narrowed = appIntents
      .map((appIntent) => {
        const listening = fresh
          ? []
          : appIntent.apps.filter(
              (app) => app.instanceId !== undefined && this.hasListener(app.instanceId, appIntent.intent.name, context?.type),
            );
        const entries = appIntent.apps.filter((app) => app.instanceId === undefined);
        const waiting = fresh
          ? []
          : entries.filter(
              (app) => this.live(app.appId).length > 0 && !listening.some((candidate) => candidate.appId === app.appId),
            );
        const launches = this.launchable ? entries.filter((app) => !waiting.includes(app)) : [];
        for (const app of waiting) booting.add(app.appId);
        return { ...appIntent, apps: [...listening, ...waiting, ...launches] };
      })
      .filter((appIntent) => appIntent.apps.length > 0);
    if (raiserId !== undefined && booting.size > 0) {
      this.reuse.set(raiserId, booting);
      setTimeout(() => {
        if (this.reuse.get(raiserId) === booting) this.reuse.delete(raiserId);
      }, 0);
    }
    return narrowed;
  }
}
