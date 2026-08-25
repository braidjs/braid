import { EnvLocation, FragmentEnv } from './fragment-env.js';
import { BoundaryChannel } from '../weave/channel.js';
import { createContextMirror } from '../weave/context-bridge.js';
import { OpenPayload, answerHandshake } from '../weave/handshake.js';
import { FRAGMENT_EVENT, PROPS_CHANGED, PropsChangedPayload } from '../weave/messages.js';
import { createClosingCoordinator } from '../weave/closing.js';

export interface CreateEnvOptions {
  contentRoot: HTMLElement;
  shadowRoot: ShadowRoot;
  routeUrl: string;
  /**
   * The fragment end of the boundary channel.
   *
   * Everything that used to cross as a host-realm closure — context reads, props, events — now
   * crosses as a message on this channel. On the trusted tier both ends live in the host realm and
   * the backing dispatches directly, so this costs a microtask and no serialization; on the
   * untrusted tier the same code runs over a `MessagePort` without knowing the difference.
   */
  channel: BoundaryChannel;
  signal: AbortSignal;
  /** Names this fragment in context-version errors. */
  fragmentId?: string;
  /**
   * The contract version this fragment speaks for each context key, from its manifest.
   *
   * A fragment built months ago reads a context published today, so it declares what it can parse
   * and the bus projects each delivery down to it. Absent, a fragment is assumed current — right for
   * one built from the same source, and the reason a fragment that knows it is behind must say so.
   */
  contextVersions?: Readonly<Record<string, number>>;
}

function parseEnvLocation(routeUrl: string): EnvLocation {
  const url = new URL(routeUrl, document.baseURI);
  return {
    href: url.href,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    basePath: url.pathname,
  };
}

/**
 * Builds the FragmentEnv for a fragment instance, and answers the host's handshake on its behalf.
 *
 * Compat fragments never consume the env — the compat adapter installs the full illusion
 * instead — but the runtime constructs one uniformly so the adapter interface is the same
 * for every adapter, and contract adapters can land later without touching the slot.
 *
 * Returns the env alongside the promise that settles at OPEN. The env is usable before then: its
 * context mirror is simply empty, which is the same thing a fragment sees today when it reads a key
 * nobody has published.
 */
export function createFragmentEnv(options: CreateEnvOptions): {
  env: FragmentEnv;
  opened: Promise<OpenPayload>;
} {
  const { contentRoot, shadowRoot, routeUrl, signal, channel } = options;

  let location = parseEnvLocation(routeUrl);
  const historyListeners = new Set<(location: EnvLocation) => void>();

  let props: Readonly<Record<string, unknown>> = {};
  const propsListeners = new Set<(props: Readonly<Record<string, unknown>>) => void>();

  const context = createContextMirror(channel);
  const closing = createClosingCoordinator(channel);

  channel.on(PROPS_CHANGED, (payload) => {
    props = ((payload ?? {}) as PropsChangedPayload).props ?? {};
    for (const listener of [...propsListeners]) {
      try {
        listener(props);
      } catch (error) {
        console.error(`braid: a props listener threw`, error);
      }
    }
  });

  const opened = answerHandshake({
    channel,
    ...(options.contextVersions === undefined ? {} : { contextVersions: options.contextVersions }),
    onOpen(open) {
      context.seed(open);
      props = open.props ?? {};
      for (const listener of [...propsListeners]) listener(props);
    },
  });

  const applyNavigation = (url: string, state: unknown, replace: boolean) => {
    const target = new URL(url, location.href);
    if (replace) {
      window.history.replaceState(state ?? null, '', target.href);
    } else {
      window.history.pushState(state ?? null, '', target.href);
    }
    location = parseEnvLocation(target.href);
    historyListeners.forEach((listener) => listener(location));
  };

  const env: FragmentEnv = {
    contractVersion: '1.0',
    root: contentRoot,
    document: {
      get title() {
        return contentRoot.querySelector('title')?.textContent ?? '';
      },
      set title(value: string) {
        const titleElement = contentRoot.querySelector('title');
        if (titleElement) {
          titleElement.textContent = value;
        }
      },
      appendToHead(element: HTMLElement) {
        (contentRoot.querySelector('braid-head') ?? contentRoot).appendChild(element);
      },
      get activeElement() {
        return shadowRoot.activeElement;
      },
      get adoptedStyleSheets() {
        return shadowRoot.adoptedStyleSheets;
      },
    },
    get location() {
      return location;
    },
    history: {
      push: (url, state) => applyNavigation(url, state, false),
      replace: (url, state) => applyNavigation(url, state, true),
      back: () => window.history.back(),
      onChange(listener) {
        historyListeners.add(listener);
        const unsubscribe = () => historyListeners.delete(listener);
        signal.addEventListener('abort', unsubscribe, { once: true });
        return unsubscribe;
      },
    },
    context: {
      get: (key) => context.get(key),
      subscribe: (key, listener, subscribeOptions) =>
        context.subscribe(key, listener, { signal: subscribeOptions?.signal ?? signal }),
    },
    get props() {
      return props;
    },
    onPropsChanged(listener) {
      propsListeners.add(listener);
      const unsubscribe = () => propsListeners.delete(listener);
      signal.addEventListener('abort', unsubscribe, { once: true });
      return unsubscribe;
    },
    emit: (type, detail) => channel.send(FRAGMENT_EVENT, { type, detail }),
    onClosing: closing.onClosing,
    setDirty: closing.setDirty,
    signal,
  };

  return { env, opened };
}
