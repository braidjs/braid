import { keySegment, localStorageStore, type PreferenceStore } from './store.js';

/**
 * A workspace for one Braid page: an area of the page where apps are launched as
 * `<fragment-slot>`s, plus what the page remembers for its user — preferences, each app's
 * settings, and named layouts of that area.
 *
 * It is a feature of the page, not of any interop standard, and needs none: with no FDC3 agent it
 * launches, saves and restores plain fragments. Beside `@braidlabs/fdc3` it composes around the
 * agent through the agent's two hooks, and adds what FDC3 leaves to the platform:
 *
 * ```ts
 * const workspace = createWorkspace();                       // the page's [data-braid-workspace]
 * const agent = createBraidDesktopAgent({
 *   directory,
 *   container: workspace.container,
 *   resolveIntent: workspace.intentResolver(dialogResolver(document, { remember: true })),
 * });
 * initBraid({ realmGlobals: workspace.realmGlobals(agent.realmGlobals) });
 * ```
 */
export interface WorkspaceOptions {
  /**
   * The workspace area: launched apps are mounted here, and a layout is its `<fragment-slot>`
   * children. Defaults to the page's `[data-braid-workspace]` element, which is what a shell
   * designed in the console with a workspace area renders — looked up when first needed, so a
   * framework may render it after the workspace is created. `null` is no area. Without one,
   * preferences and app settings still work; launching and layouts reject.
   */
  container?: Element | null;
  /**
   * Where preferences, app settings and layouts are kept. Defaults to {@link localStorageStore};
   * {@link serverStore} keeps them on the gateway, per signed-in user.
   */
  store?: PreferenceStore;
}

/** The user's preferences for the whole page. */
export interface HostPreferences {
  /** An FDC3 user channel id (`fdc3.channel.1`…`8`) every fragment joins before its code runs. Needs an FDC3 agent. */
  defaultUserChannel?: string;
  /** App ids never offered as a choice when resolving an intent. */
  hiddenApps?: string[];
}

/** What {@link Workspace.layouts} saves: the workspace area's slots, in order. */
export interface SavedLayout {
  version: 1;
  savedAt: string;
  slots: SavedSlot[];
}

export interface SavedSlot {
  appId: string;
  src?: string;
  props?: Record<string, unknown>;
  /** The FDC3 user channel the instance was on, when the page runs an agent. */
  channel?: string;
  /** What the app returned from `braidDesktop.onSaveLayout`. */
  state?: unknown;
}

/** The workspace's additions for one fragment, as `window.braidDesktop`. */
export interface BraidDesktopApi {
  /** This app's settings for the signed-in user: shared by its instances, apart from other apps'. */
  settings: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  /**
   * Supplies this instance's state when the workspace's layout is saved: JSON, within 2 seconds.
   * The handler registered last is the one asked. Returns an unsubscribe.
   */
  onSaveLayout(handler: () => unknown): () => void;
  /** The state this instance saved, when it was mounted by restoring a layout; otherwise undefined. */
  readonly restoredState: unknown;
}

/** What `initBraid({ realmGlobals })` calls for each fragment. */
export interface WorkspaceFragment {
  fragmentId: string;
  signal: AbortSignal;
  /** The `<fragment-slot>` the fragment boots in. */
  slot?: Element;
}

/** A `realmGlobals` hook, such as an FDC3 agent's. */
export type RealmGlobals<F extends WorkspaceFragment = WorkspaceFragment> = (
  fragment: F,
) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;

/** The parts of an intent candidate the workspace reads; an FDC3 agent's `IntentCandidate` is one. */
export interface WorkspaceIntentCandidate {
  intent: string;
  appId: string;
  instanceId?: string;
}

/** An intent resolver hook, as `createBraidDesktopAgent({ resolveIntent })` takes. */
export type WorkspaceIntentResolver<C extends WorkspaceIntentCandidate, R extends { context?: { type?: unknown }; candidates: C[] }> = (
  request: R,
) => Promise<{ candidate: C; remember?: boolean } | undefined>;

export interface Workspace {
  /** The workspace area, or undefined when the page has none. */
  readonly container: Element | undefined;
  /**
   * The hook for `initBraid({ realmGlobals })`. Every fragment gets `braidDesktop`, on top of
   * whatever `inner` gives it — pass an FDC3 agent's `realmGlobals` and a fragment with an `fdc3`
   * also joins its saved channel, or the user's default one, before any of its code runs.
   */
  realmGlobals<F extends WorkspaceFragment>(inner?: RealmGlobals<F>): (fragment: F) => Promise<Record<string, unknown>>;
  /**
   * Wraps an intent resolver with the user's preferences: hidden apps are never offered, a
   * remembered choice answers without asking, and an answer with `remember: true` is kept.
   * Without `inner`, a raise that still has several candidates is cancelled.
   */
  intentResolver<C extends WorkspaceIntentCandidate, R extends { context?: { type?: unknown }; candidates: C[] }>(
    inner?: WorkspaceIntentResolver<C, R>,
  ): WorkspaceIntentResolver<C, R>;
  /** Mounts an app at the end of the workspace area, and returns its `<fragment-slot>`. */
  open(appId: string, options?: { src?: string; props?: Record<string, unknown> }): Element;
  preferences: {
    getHost(): Promise<HostPreferences>;
    /** Replaces the page's preferences; fragments that boot from now on get them. */
    setHost(preferences: HostPreferences): Promise<void>;
    /** The app remembered for an intent and context type, if any. */
    intentChoice(intent: string, contextType: string): Promise<string | undefined>;
    forgetIntentChoice(intent: string, contextType: string): Promise<void>;
  };
  /** Saved layouts of the workspace area. */
  layouts: {
    save(name: string): Promise<SavedLayout>;
    /** Replaces the area's slots with the saved ones. Rejects if there is no such layout. */
    restore(name: string): Promise<void>;
    list(): Promise<string[]>;
    delete(name: string): Promise<void>;
  };
}

/** How long saving a layout waits for each app's state. */
const SAVE_STATE_TIMEOUT_MS = 2_000;
/** How long a fragment's boot waits to read the page's preferences before going without. */
const HOST_READ_TIMEOUT_MS = 1_000;
/** How long a fragment's boot waits to join its channel. */
const JOIN_TIMEOUT_MS = 2_000;

const HOST_KEY = 'host';
const intentKey = (intent: string, contextType: string) => `intents/${keySegment(intent)}/${keySegment(contextType)}`;
const layoutKey = (name: string) => `layouts/${keySegment(name)}`;
const appPrefix = (appId: string) => `apps/${keySegment(appId)}/`;

/** The parts of an FDC3 `DesktopAgent` the workspace uses, when a fragment has one. */
interface Fdc3Channels {
  joinUserChannel(channelId: string): Promise<void>;
  getCurrentChannel(): Promise<{ id: string; type: string } | null>;
}

/** One booted fragment in a slot. */
interface Instance {
  fdc3?: Fdc3Channels;
  saveHandlers: Set<() => unknown>;
}

export function createWorkspace(options: WorkspaceOptions = {}): Workspace {
  let found: Element | undefined;
  /** The area: the one given, or the page's, once it is there. */
  const area = (): Element | undefined => {
    if (options.container !== undefined) return options.container ?? undefined;
    if (!found?.isConnected) found = (typeof document === 'undefined' ? null : document.querySelector('[data-braid-workspace]')) ?? undefined;
    return found;
  };
  const store = options.store ?? localStorageStore();

  /** What a slot mounted by a restore gives its fragment when it boots. */
  const restores = new WeakMap<Element, { channel?: string; state?: unknown }>();
  /** Booted fragments, by the slot they are in. */
  const bySlot = new WeakMap<Element, Instance>();

  /**
   * The page's preferences, read once and kept: every fragment's boot waits on them, so a slow
   * store must not slow every boot. A read that fails or takes too long is no preferences — not a
   * fragment that fails to boot — and is tried again next time.
   */
  let host: Promise<HostPreferences> | undefined;
  function hostPreferences(): Promise<HostPreferences> {
    host ??= withTimeout(store.get(HOST_KEY), HOST_READ_TIMEOUT_MS).then(
      (stored) => (stored && typeof stored === 'object' ? (stored as HostPreferences) : {}),
      () => {
        host = undefined;
        return {};
      },
    );
    return host;
  }

  /**
   * The remembered app's candidate: its one running instance, or the app itself when it is not
   * running. Anything else — two instances, or the app no longer a candidate — is the user's call.
   */
  async function remembered<C extends WorkspaceIntentCandidate>(candidates: C[], contextType: string): Promise<C | undefined> {
    const matches: C[] = [];
    for (const intent of new Set(candidates.map((candidate) => candidate.intent))) {
      let appId: unknown;
      try {
        appId = ((await store.get(intentKey(intent, contextType))) as { appId?: unknown } | undefined)?.appId;
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

  function braidDesktopFor(appId: string, instance: Instance, restoredState: unknown): BraidDesktopApi {
    const prefix = appPrefix(appId);
    return Object.freeze({
      settings: Object.freeze({
        get: (key: string) => store.get(prefix + keySegment(String(key))),
        set: (key: string, value: unknown) => store.set(prefix + keySegment(String(key)), value),
        delete: (key: string) => store.delete(prefix + keySegment(String(key))),
        keys: async () => decodedSegments(await store.list(prefix), prefix),
      }),
      onSaveLayout(handler: () => unknown) {
        if (typeof handler !== 'function') throw new TypeError('braidDesktop.onSaveLayout takes a function');
        instance.saveHandlers.add(handler);
        return () => void instance.saveHandlers.delete(handler);
      },
      restoredState: restoredState === undefined ? undefined : structuredClone(restoredState),
    });
  }

  function needContainer(): Element {
    const container = area();
    if (!container) {
      throw new Error('braid-workspace: the page has no workspace area (createWorkspace({ container }), or a [data-braid-workspace] element)');
    }
    return container;
  }

  /** The state an instance gives for a layout: JSON, within the timeout, or nothing. */
  async function stateOf(instance: Instance | undefined): Promise<unknown> {
    const handler = instance && [...instance.saveHandlers].at(-1);
    if (!handler) return undefined;
    try {
      const state = await withTimeout(Promise.resolve().then(handler), SAVE_STATE_TIMEOUT_MS);
      return state === undefined ? undefined : JSON.parse(JSON.stringify(state));
    } catch {
      return undefined;
    }
  }

  async function savedSlot(slot: Element): Promise<SavedSlot> {
    const saved: SavedSlot = { appId: slot.getAttribute('name')! };
    const instance = bySlot.get(slot);
    const src = slot.getAttribute('src');
    if (src !== null) saved.src = src;
    const props = (slot as Element & { props?: Record<string, unknown> }).props;
    if (props && typeof props === 'object' && Object.keys(props).length > 0) saved.props = JSON.parse(JSON.stringify(props));
    const fdc3 = instance?.fdc3;
    const [channel, state] = await Promise.all([
      fdc3 ? withTimeout(fdc3.getCurrentChannel(), SAVE_STATE_TIMEOUT_MS).catch(() => null) : null,
      stateOf(instance),
    ]);
    if (channel?.type === 'user' && typeof channel.id === 'string') saved.channel = channel.id;
    if (state !== undefined) saved.state = state;
    return saved;
  }

  return {
    get container() {
      return area();
    },

    realmGlobals(inner) {
      return async (fragment) => {
        const { fragmentId, signal, slot } = fragment;
        // a hook that fails has given nothing: the fragment still gets its braidDesktop
        const globals = (inner ? await Promise.resolve(inner(fragment)).catch(() => undefined) : undefined) ?? {};
        const restore = slot ? restores.get(slot) : undefined;
        const fdc3 = isFdc3(globals.fdc3) ? globals.fdc3 : undefined;
        if (fdc3 && !signal.aborted) {
          const channel = restore?.channel ?? (await hostPreferences()).defaultUserChannel;
          // a channel the agent does not have, or one slow to join, is no channel
          if (typeof channel === 'string') await withTimeout(fdc3.joinUserChannel(channel), JOIN_TIMEOUT_MS).catch(() => undefined);
        }
        const instance: Instance = { ...(fdc3 ? { fdc3 } : {}), saveHandlers: new Set() };
        if (slot && !signal.aborted) {
          restores.delete(slot);
          bySlot.set(slot, instance);
          signal.addEventListener('abort', () => void (bySlot.get(slot) === instance && bySlot.delete(slot)), { once: true });
        }
        return { ...globals, braidDesktop: braidDesktopFor(fragmentId, instance, restore?.state) };
      };
    },

    intentResolver(inner) {
      return async (request) => {
        const { hiddenApps = [] } = await hostPreferences();
        const hidden = Array.isArray(hiddenApps) ? hiddenApps : [];
        const candidates = request.candidates.filter((candidate) => !hidden.includes(candidate.appId));
        if (candidates.length === 0) return undefined;
        if (candidates.length === 1) return { candidate: candidates[0] };
        const contextType = typeof request.context?.type === 'string' ? request.context.type : 'fdc3.nothing';
        const known = await remembered(candidates, contextType);
        if (known) return { candidate: known };
        const answer = await inner?.({ ...request, candidates });
        if (!answer) return undefined;
        // only what was offered is remembered: the agent refuses anything else anyway
        const offered = candidates.find(
          (candidate) =>
            candidate.intent === answer.candidate?.intent &&
            candidate.appId === answer.candidate.appId &&
            (candidate.instanceId ?? null) === (answer.candidate.instanceId ?? null),
        );
        if (offered && answer.remember) await store.set(intentKey(offered.intent, contextType), { appId: offered.appId }).catch(() => undefined);
        return answer;
      };
    },

    open(appId, app = {}) {
      if (typeof appId !== 'string' || appId === '') throw new TypeError('braid-workspace: open takes an app id');
      return mountSlot(needContainer(), { appId, ...app });
    },

    preferences: {
      getHost: hostPreferences,
      async setHost(preferences) {
        const value = JSON.parse(JSON.stringify(preferences ?? {})) as HostPreferences;
        await store.set(HOST_KEY, value);
        host = Promise.resolve(value);
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
        // every app at once: one that is slow to give its state does not hold up the rest
        const named = slotsIn(needContainer()).filter((slot) => slot.getAttribute('name'));
        const layout: SavedLayout = { version: 1, savedAt: new Date().toISOString(), slots: await Promise.all(named.map(savedSlot)) };
        await store.set(layoutKey(name), layout);
        return layout;
      },

      async restore(name) {
        const target = needContainer();
        const layout = (await store.get(layoutKey(name))) as SavedLayout | undefined;
        if (!layout || layout.version !== 1 || !Array.isArray(layout.slots)) {
          throw new Error(`braid-workspace: no saved layout "${name}"`);
        }
        for (const slot of slotsIn(target)) slot.remove();
        for (const saved of layout.slots) {
          if (typeof saved?.appId !== 'string' || saved.appId === '') continue;
          mountSlot(target, saved, (slot) => restores.set(slot, { channel: saved.channel, state: saved.state }));
        }
      },

      async list() {
        return decodedSegments(await store.list('layouts/'), 'layouts/');
      },

      async delete(name) {
        await store.delete(layoutKey(name));
      },
    },
  };
}

function isFdc3(value: unknown): value is Fdc3Channels {
  const agent = value as Partial<Fdc3Channels> | null | undefined;
  return typeof agent?.joinUserChannel === 'function' && typeof agent.getCurrentChannel === 'function';
}

/** `promise`, or a rejection once `ms` have passed; the timer does not outlive it. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Keys under `prefix`, decoded back to the names they were made from; one that does not decode is skipped. */
function decodedSegments(keys: string[], prefix: string): string[] {
  return keys.flatMap((key) => {
    try {
      return [decodeURIComponent(key.slice(prefix.length))];
    } catch {
      return [];
    }
  });
}

/** The `<fragment-slot>` children of the workspace area, in document order. */
function slotsIn(container: Element): Element[] {
  return [...container.children].filter((child) => child.localName === 'fragment-slot');
}

/**
 * Mounts a `<fragment-slot>` for an app at the end of the area. `prepare` runs before the slot
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
