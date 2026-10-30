/* eslint-disable @typescript-eslint/no-unsafe-function-type --
 * ported from the matrix-tested web-fragments fork: constructor and History-method interception
 * operates on arbitrary native function shapes. */
import { CompatShadowRoot, compatMetadataSymbol, setInternalReference, getInternalReference } from './metadata.js';
import { execToInertScriptMap } from './script-execution.js';
import { assert } from '../utils/assert.js';
import { installDocumentFacade } from './document-facade.js';
import { createDocumentOverrides } from './document-overrides.js';
import { createFragmentBoundary, FragmentBoundary } from './fragment-boundary.js';
import { makeScriptBornInert } from './born-inert-scripts.js';
import { navigationBus, ensureHostNavigationSources } from './navigation-bus.js';
import { createRealmNavigator } from './service-worker.js';
import { installSharedGlobals } from './shared-globals.js';
import { installStoragePartition, type StoragePartition } from './storage-partition.js';
import { nativeCookieAccessor, partitionCookie } from './cookie-partition.js';
import { RealmHandle } from '../realm/realm-manager.js';

/**
 * Realm-side monkey patches: applied to the fragment's own realm window so
 * that code running in it behaves as if it were running in the main frame.
 *
 * Everything here patches objects the runtime itself created (the hidden realm iframe) or nodes
 * confined to the fragment's boundary — nothing is installed on the host page's globals or
 * prototypes. The host's `sharedGlobals` are the one deliberate channel back: realm accessors for
 * host properties the host named itself.
 */
export interface RealmContext extends FragmentBoundary {
  /**
   * Ends the boot window, after which a bound fragment's navigations may drive the host URL.
   *
   * Called by the adapter once the fragment's own scripts have run. See the boot-window note in
   * the history patches: a router resolving its initial route is not the user navigating.
   */
  bootComplete(): void;
}

export function initializeRealmContext(
  realm: RealmHandle,
  fragmentShadowRoot: CompatShadowRoot,
  braidDocumentElement: HTMLElement,
  boundNavigation: boolean,
  fragmentAbortController: AbortController,
  sharedGlobals: readonly string[] = [],
  storagePartition?: string,
): RealmContext {
  assert(realm.window !== null && realm.document !== null, 'attempted to patch the realm before it was ready');

  const realmWindow = realm.window;
  const realmDocument = realm.document;

  const mainDocument = fragmentShadowRoot.host.ownerDocument;
  const mainWindow = mainDocument.defaultView!;

  // cleanup event listeners attached to the window when the realm iframe gets destroyed.
  // TODO: "pagehide" would be preferred over the discouraged "unload" event, but we'd need to
  // figure out how to restore the previously attached listeners if the page resumes from bfcache
  realmWindow.addEventListener('unload', () => fragmentAbortController.abort());

  /**
   * All main-realm interception is confined to the fragment boundary: nodes inside the
   * fragment's DOM are stamped with per-fragment prototypes and a shadow-root-scoped
   * MutationObserver acts as the activation safety net.
   */
  const fragmentBoundary = createFragmentBoundary({
    realmDocument,
    shadowRoot: fragmentShadowRoot,
    braidDocumentElement,
    abortSignal: fragmentAbortController.signal,
  });

  /** ---------------------------------------------- Window Patches ------------------------------------------------ */

  /**
   * START> WINDOW: GLOBAL CONSTRUCTORS PATCHES
   */
  const globalConstructors: Function[] = Object.entries(Object.getOwnPropertyDescriptors(realmWindow)).flatMap(
    ([property, descriptor]) =>
      /^[A-Z]/.test(property) && typeof descriptor.value === 'function' ? descriptor.value : [],
  );

  function hasInstance(this: Function, instance: any) {
    const parentContextConstructor: Function = mainWindow[this.name as keyof typeof mainWindow];

    return (
      Function.prototype[Symbol.hasInstance].call(this, instance) ||
      (typeof parentContextConstructor === 'function' && instance instanceof parentContextConstructor)
    );
  }

  // extend global constructors to support instanceof checks using
  // their equivalent constructor from the parent execution context
  globalConstructors.forEach((constructor) => {
    try {
      Object.defineProperty(constructor, Symbol.hasInstance, {
        value: hasInstance,
      });
    } catch (e) {
      console.warn(
        `Braid compat: failed to patch \`${constructor.name}[Symbol.hasInstance]\`\nA browser extension might be interfering with the browser APIs...\nSome application functionality may not work as expected!`,
        '\nError:',
        e,
        `\nDescriptor:`,
        Object.getOwnPropertyDescriptor(constructor, Symbol.hasInstance),
      );
    }
  });
  // END> WINDOW: GLOBAL CONSTRUCTORS PATCHES

  /**
   * START> WINDOW: MISC PATCHES
   */
  realmWindow.IntersectionObserver = mainWindow.IntersectionObserver;
  realmWindow.MutationObserver = mainWindow.MutationObserver;
  realmWindow.ResizeObserver = mainWindow.ResizeObserver;

  // CSSStyleSheets don't work across documents, so we need to use the constructor from the main context
  realmWindow.CSSStyleSheet = mainWindow.CSSStyleSheet;

  realmWindow.matchMedia = mainWindow.matchMedia.bind(mainWindow); // needs to be bound to mainWindow otherwise operates on the realm window

  // The realm's navigator is the host's, with one member contained: a service worker attaches to
  // the whole origin and outlives the fragment, so a fragment must not be able to install one.
  // See service-worker.ts — the realm isolates JavaScript, and a worker is not JavaScript state.
  const realmNavigator = createRealmNavigator(mainWindow.navigator, realm.fragmentId);
  // the navigator API is defined as an enumerable and configurable property with a getter and an undefined setter
  Object.defineProperty(realmWindow, 'navigator', {
    set: undefined,
    get: () => realmNavigator,
    configurable: true,
    enumerable: true,
  });

  // A partitioned fragment gets Web Storage of its own instead of the host origin's. Before any
  // fragment script, like every patch here; its `storage` events are translated in the proxy
  // listener below, and `onstorage` is routed through it at the end of the event patches.
  const partition: StoragePartition | null = storagePartition
    ? installStoragePartition(realmWindow, mainWindow, storagePartition, fragmentAbortController.signal)
    : null;

  // dispatch events onto the shadowRoot if the event is not one of the special realm events
  const originalDispatchEvent = realmWindow.dispatchEvent.bind(realmWindow);
  realmWindow.dispatchEvent = function compatDispatchEvent(event: Event): boolean {
    if (realmEvents.includes(event?.type)) {
      return originalDispatchEvent(event);
    } else {
      return fragmentShadowRoot.dispatchEvent(event);
    }
  };

  const windowSizeProperties: (keyof Pick<
    Window,
    'innerHeight' | 'innerWidth' | 'outerHeight' | 'outerWidth' | 'visualViewport'
  >)[] = ['innerHeight', 'innerWidth', 'outerHeight', 'outerWidth', 'visualViewport'];
  for (const windowSizeProperty of windowSizeProperties) {
    Object.defineProperty(realmWindow, windowSizeProperty, {
      get: function compatWindowSizeGetter() {
        return mainWindow[windowSizeProperty];
      },
    });
  }

  // Host globals the host chose to share (its analytics data layer, tag manager…). Installed after
  // the realm's own patches, so a name compat has already claimed is skipped rather than replaced.
  installSharedGlobals(realmWindow, mainWindow, sharedGlobals, realm.fragmentId);
  // END> WINDOW: MISC PATCHES

  /**
   * START> WINDOW: HISTORY PATCHES
   */

  // WARNING: Be sure this class stays declared inside of this function!
  // We rely on each compat context having its own instance of this constructor
  // so we can use an instanceof check to avoid double-handling the event inside
  // the same context it was dispatched from.
  class SyntheticPopStateEvent extends PopStateEvent {}

  /**
   * True until the fragment's own scripts have finished running.
   *
   * A framework's router performs an initial navigation as it starts — resolving a default route,
   * following a `redirectTo`, normalizing a trailing slash. That is the fragment settling into the
   * route it was *given*, not the user navigating, and letting it reach the host's History API
   * means a fragment can rewrite the host's URL the instant it mounts.
   */
  let booting = true;

  /**
   * Whether the user has acted inside this fragment.
   *
   * **Scripts having run is not the same as the router having settled**, and assuming it was is
   * what let this bug survive its first fix. Angular resolves its initial route asynchronously —
   * measured at ~170ms after mount, long after the last `<script>` returned — so a window that
   * closed when boot finished was already open again by the time the redirect landed, and a
   * fragment mounted on a page it does not own dragged the host to one of its own routes.
   *
   * No timing fix survives that honestly: the next router is slower than whatever delay we pick.
   * So the gate is causal rather than temporal — a navigation the user did not ask for stays
   * inside the realm, whenever it happens. The fragment still navigates itself; it just cannot
   * move the address bar until someone touches it.
   *
   * The cost is deliberate: a bound fragment that redirects with no user input (an async auth
   * check, say) now changes only its own location. That is the safer default of the two, and the
   * host URL staying where the host put it is the property worth keeping.
   */
  let userHasActed = false;

  // Capture phase, so a fragment that stops propagation on its own handlers cannot also suppress
  // the signal that it is being used.
  for (const eventName of ['pointerdown', 'keydown', 'touchstart'] as const) {
    braidDocumentElement.addEventListener(eventName, () => void (userHasActed = true), {
      capture: true,
      signal: fragmentAbortController.signal,
    });
  }

  if (boundNavigation) {
    setInternalReference(realmWindow, 'history');

    const historyProxy = new Proxy(mainWindow.history, {
      get(target, property, receiver) {
        if (typeof Object.getOwnPropertyDescriptor(History.prototype, property)?.value === 'function') {
          return function (this: unknown, ...args: unknown[]) {
            // During boot, a bound fragment's navigation is confined to its own realm: the host
            // keeps the URL it navigated to, and the fragment still gets the location it asked for.
            if ((booting || !userHasActed) && MUTATING_HISTORY_METHODS.has(property as string)) {
              return Reflect.apply(
                History.prototype.replaceState as Function,
                getInternalReference(realmWindow, 'history'),
                [args[0], args[1] ?? '', args[2] ?? realmWindow.location.href],
              );
            }

            const applyNavigation = () =>
              Reflect.apply(History.prototype[property as keyof History] as Function, this === receiver ? target : this, args);

            // suppress the automatic host navigation sources while we apply the mutation, so
            // this fragment-initiated navigation isn't re-reported as a host navigation
            const result = navigationBus.withFragmentNavigation(applyNavigation);

            // dispatch a popstate event on the main window to inform listeners of a location change
            // (both the host application and the other fragments observe navigations this way)
            mainWindow.dispatchEvent(new SyntheticPopStateEvent('popstate'));
            return result;
          };
        }

        return Reflect.get(target, property, target);
      },
      set(target, property, receiver) {
        return Reflect.set(target, property, receiver);
      },
    });

    Object.defineProperties(realmWindow, {
      history: {
        get() {
          return historyProxy;
        },
      },
    });
  } else {
    const standaloneHistoryStack: Array<{ state: any; title: string; url: string | null }> = [
      { state: realmWindow.history.state, title: realmDocument.title, url: realmWindow.location.href },
    ];
    let standaloneHistoryCursor = 0;

    // for standalone fragments we should always use replaceState instead of pushState so that we
    // don't create unexpected history entries in the joint session history. In order for back()
    // and forward() to work correctly, we implement our own history stack with behavior similar
    // to window.history
    Object.defineProperties(realmWindow.history, {
      pushState: {
        value: function compatStandalonePushState(state: any, title: string, url?: string | null) {
          if (standaloneHistoryCursor !== standaloneHistoryStack.length - 1) {
            standaloneHistoryStack.splice(standaloneHistoryCursor + 1);
          }
          standaloneHistoryStack.push({ state, title, url: url ?? null });
          standaloneHistoryCursor++;
          realmWindow.history.replaceState(state, title, url);
        },
      },

      /**
       * Traverses the virtual stack and tells the fragment about it.
       *
       * The `popstate` is not decoration: a router only learns it has moved by hearing one, so
       * without it `back()` changed the URL and left the application rendering the previous route.
       */
      go: {
        value: function compatStandaloneGo(delta?: number) {
          // Unpatched, this reached the real `go()` — which traverses the **joint** session
          // history and drags the top document with it. That is the whole hazard this branch
          // exists to avoid, and it was reachable by any router calling `go(-1)`.
          const steps = Math.trunc(delta ?? 0);
          if (steps === 0) return;

          const next = Math.min(Math.max(standaloneHistoryCursor + steps, 0), standaloneHistoryStack.length - 1);
          if (next === standaloneHistoryCursor) return;

          standaloneHistoryCursor = next;
          const { state, title, url } = standaloneHistoryStack[standaloneHistoryCursor];
          realmWindow.history.replaceState(state, title, url);
          realmWindow.dispatchEvent(new PopStateEvent('popstate', { state }));
        },
      },

      back: {
        value: function compatStandaloneBack() {
          realmWindow.history.go(-1);
        },
      },

      forward: {
        value: function compatStandaloneForward() {
          realmWindow.history.go(1);
        },
      },

      length: {
        get() {
          return standaloneHistoryStack.length;
        },
      },
    });
  }

  if (boundNavigation) {
    // When a navigation event occurs on the main window, either programmatically through the
    // History API or by the back/forward button, we need to reflect those changes onto the
    // realm's location via history.replaceState(), then dispatch a PopStateEvent so that
    // fragments listening to popstate are made aware of the location change and retrigger
    // their render updates.
    const handleNavigate = (e: Event) => {
      getInternalReference(realmWindow, 'history').replaceState(window.history.state, '', window.location.href);

      if (e instanceof SyntheticPopStateEvent) {
        return;
      }

      realmWindow.dispatchEvent(new PopStateEvent('popstate', e instanceof PopStateEvent ? e : undefined));
    };

    // host-initiated pushState/replaceState calls are detected without patching the host's
    // History API: via the onHostNavigation adapter and/or the Navigation API
    const unsubscribe = navigationBus.subscribe(() => handleNavigate(new Event('braid:host-navigation')));
    fragmentAbortController.signal.addEventListener('abort', unsubscribe);
    ensureHostNavigationSources();

    // Forward the popstate event triggered on the main window to every registered realm window.
    // This covers native back/forward navigations as well as the synthetic popstate events
    // dispatched by any fragment's history proxy.
    window.addEventListener('popstate', handleNavigate, {
      signal: fragmentAbortController.signal,
    });
  }
  // END> WINDOW: HISTORY PATCHES

  /** ---------------------------------------------- Document Patches ------------------------------------------------ */

  /**
   * START> DOCUMENT PATCHES
   *
   * The Document API surface is virtualized via a proxy facade spliced into the document's
   * prototype chain. The virtualized member implementations live in document-overrides.ts, and
   * every Document member's audit status is recorded in document-member-classification.ts.
   *
   * Note: native references (body, currentScript) must be captured before the facade is installed.
   */
  setInternalReference(realmDocument, 'body');

  const getUnpatchedRealmDocumentCurrentScript = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Object.getPrototypeOf(realmDocument)),
    'currentScript',
  )!.get!.bind(realmDocument);

  const documentOverrides = createDocumentOverrides({
    realmDocument,
    mainDocument,
    braidDocumentElement,
    fragmentShadowRoot,
    boundNavigation,
    getRealmDocumentReadyState: () => fragmentShadowRoot[compatMetadataSymbol].documentReadyState,
    // grab the currently executing script in the realm, and map it to its clone in the main document
    getCurrentScript: () => execToInertScriptMap.get(getUnpatchedRealmDocumentCurrentScript()),
    boundary: {
      stampNode: fragmentBoundary.stampNode,
      makeScriptBornInert,
    },
    // a partitioned fragment sees its own cookies through document.cookie, as the gateway sends
    // them to its endpoint
    ...(storagePartition ? { cookie: partitionCookie(nativeCookieAccessor(realmDocument), storagePartition) } : {}),
  });
  installDocumentFacade(realmDocument, documentOverrides);
  // END> DOCUMENT PATCHES

  /** ---------------------------------------------- Event System Patches ------------------------------------------------ */

  /**
   * START> EVENT SYSTEM PATCHES
   */

  // A list of events for which we don't want to retarget listeners as these events are dispatched in the realm.
  const realmEvents = ['load', 'popstate', 'beforeunload', 'unload'];

  // Maps realm EventTargets (window and document) to a target in the main context
  const realmTargetToFragmentTarget = (target: EventTarget): EventTarget => {
    switch (target) {
      case realmWindow:
        return fragmentShadowRoot;
      case realmDocument:
        return braidDocumentElement;
      default:
        return target;
    }
  };

  const mainTargetToRealmTarget = (target: EventTarget): EventTarget => {
    switch (target) {
      case mainWindow:
        return realmWindow;
      case mainDocument:
        return realmDocument;
      case mainDocument.documentElement:
        return realmDocument.documentElement;
      case mainDocument.body:
        return realmDocument.body;
      default:
        console.warn('Braid compat events: Unknown main context target: ', target);
        return target;
    }
  };

  const fragmentTargetToMainTarget = (target: EventTarget): EventTarget => {
    switch (target) {
      case fragmentShadowRoot:
        return mainWindow;
      case braidDocumentElement:
        return mainDocument;
      case realmDocument.documentElement:
        return mainDocument.documentElement;
      case realmDocument.body:
        return mainDocument.body;
      default:
        console.warn('Braid compat events: Unknown fragment context target: ', target);
        return target;
    }
  };

  // Weak map that maps app-provided listeners to listeners actually registered with the DOM.
  // The main purpose of this map is to facilitate deregistration of event listeners
  const appToCompatListenerMap = new WeakMap<
    EventListener,
    { compatListener: EventListener; mainProxyListener: EventListener }
  >();

  // Redirect event listeners (except for `realmEvents` defined above)
  // from the realm window or document to the shadow root.
  const compatAddEventListener = new Proxy(realmWindow.EventTarget.prototype.addEventListener, {
    apply(
      originalAddEventListener,
      originalListenerTarget,
      argumentsList: Parameters<typeof realmWindow.EventTarget.prototype.addEventListener>,
    ) {
      const [eventName, appListenerOrObject, optionsOrCapture] = argumentsList;

      // if the app didn't pass a listener, ignore the call
      if (!appListenerOrObject) return;

      if (!originalListenerTarget) {
        // addEventListener can be called unbound, in which case the target is the realm window
        originalListenerTarget = realmWindow;
      }

      // if the event is a realm event, then skip everything and register the listener directly on the realm window
      if (realmEvents.includes(eventName) && originalListenerTarget === realmWindow) {
        originalAddEventListener.call(realmWindow, eventName, appListenerOrObject, optionsOrCapture);
        return;
      }

      // normalize the options object
      const options =
        typeof optionsOrCapture === 'boolean'
          ? { capture: optionsOrCapture }
          : typeof optionsOrCapture === 'object'
            ? optionsOrCapture ?? {}
            : {};

      // browsers default to passive events for the following events
      // https://dom.spec.whatwg.org/#default-passive-value
      if (
        !('passive' in options) &&
        (eventName === 'mousewheel' ||
          eventName === 'touchstart' ||
          eventName === 'touchmove' ||
          eventName === 'wheel') &&
        (originalListenerTarget === realmWindow ||
          originalListenerTarget === realmDocument ||
          originalListenerTarget === realmDocument.documentElement ||
          originalListenerTarget === realmDocument.body)
      ) {
        options.passive = true;
      }

      // normalize appListener
      const appListener =
        typeof appListenerOrObject === 'object' ? appListenerOrObject?.handleEvent : appListenerOrObject;

      if (!appListener) {
        // this is some kind of unknown listener, possibly feature detection for passive event
        // support like the one performed by react
        Reflect.apply(originalAddEventListener, originalListenerTarget, argumentsList);
        return;
      }

      // reuse or create if needed a wrapper around the appListener that will patch the event to
      // make it look like an event the app receives in standalone mode.
      let { compatListener, mainProxyListener } = appToCompatListenerMap.get(appListener) ?? {};

      if (!compatListener || !mainProxyListener) {
        // create the compat listener
        compatListener = function compatListener(event: Event) {
          // capture properties of the original event
          const originalEventProps = {
            target: event.target,
            currentTarget: event.currentTarget,
            // TODO(perf): could we defer the composedPath() call until we actually need it
            composedPath: event.composedPath(),
          };

          // rewrite the composedPath by removing any references to the main or fragment objects
          let compatComposedPath = [...originalEventProps.composedPath];

          if (compatComposedPath.length === 1 && compatComposedPath[0] === fragmentShadowRoot) {
            compatComposedPath = [realmWindow];
          } else {
            compatComposedPath.splice(
              // remove braidDocumentElement and everything above it
              originalEventProps.composedPath.indexOf(braidDocumentElement),
              Infinity,
              // and add the realmDocument and realmWindow to the list
              realmDocument,
              realmWindow,
            );
          }

          // patch the event
          const originalEventPrototype = Object.getPrototypeOf(event);
          const eventPatch = Object.create(originalEventPrototype, {
            currentTarget: {
              get() {
                return originalListenerTarget;
              },
            },

            composedPath: {
              value: () => {
                return compatComposedPath;
              },
            },

            target: {
              get() {
                return originalEventProps.target === fragmentShadowRoot ? realmWindow : originalEventProps.target;
              },
            },
          });

          if (event instanceof UIEvent) {
            Object.defineProperty(eventPatch, 'view', {
              get() {
                return realmWindow;
              },
            });
          }

          // splice the patched event object into the prototype chain, this ensures that:
          // - the instanceof checks keep on working
          // - the isTrusted property is preserved
          // - the properties we need to patch get overshadowed in the prototypical lookup
          // - unpatching the event is as simple as re-splicing the prototype chain later
          Object.setPrototypeOf(event, eventPatch);

          try {
            appListener.call(originalListenerTarget, event);
          } finally {
            // unpatch the event
            Object.setPrototypeOf(event, originalEventPrototype);
          }
        };

        // create the proxy listener retargeting the events from the main context
        mainProxyListener = function compatProxyListener(event) {
          if (
            event.target !== mainWindow &&
            event.target !== mainDocument &&
            event.target !== mainDocument.documentElement &&
            event.target !== mainDocument.body
          ) {
            // if the event doesn't target any of the main top level EventTargets then we can ignore it —
            // it is either not relevant for us or it targets an element in the fragment DOM and
            // we'll handle it once it trickles down there
            return;
          }

          // a partition hears only about its own keys, named as it named them
          const storageView = partition && event.type === 'storage' ? partition.adaptEvent(event as StorageEvent) : undefined;
          if (storageView === null) return;

          // capture properties of the original event
          const originalEventProps = {
            target: event.target,
            currentTarget: event.currentTarget,
          };

          // rewrite the composedPath by removing any references to the main or fragment objects
          const compatComposedPath = event.composedPath().map(mainTargetToRealmTarget);

          // patch the event
          const originalEventPrototype = Object.getPrototypeOf(event);
          const eventPatch = Object.create(originalEventPrototype, {
            currentTarget: {
              get() {
                return originalListenerTarget;
              },
            },

            target: {
              get() {
                return mainTargetToRealmTarget(originalEventProps.target!);
              },
            },

            composedPath: {
              value: () => {
                return compatComposedPath;
              },
            },
          });

          if (event instanceof UIEvent) {
            Object.defineProperty(eventPatch, 'view', {
              get() {
                return realmWindow;
              },
            });
          }

          if (storageView) {
            Object.defineProperties(eventPatch, {
              key: { get: () => storageView.key },
              storageArea: { get: () => storageView.storageArea },
            });
          }

          // splice the patched event object into the prototype chain (see compatListener above)
          Object.setPrototypeOf(event, eventPatch);

          try {
            appListener.call(originalListenerTarget, event);
          } finally {
            // unpatch the event
            Object.setPrototypeOf(event, originalEventPrototype);
          }
        };

        appToCompatListenerMap.set(appListener, {
          compatListener,
          mainProxyListener,
        });
      }

      // determine the actual registration target within the fragment DOM tree
      const compatListenerTarget = realmTargetToFragmentTarget(originalListenerTarget);
      const modifiedArgumentsList = [eventName, compatListener, options];
      Reflect.apply(originalAddEventListener, compatListenerTarget, modifiedArgumentsList);

      if (eventName === 'DOMContentLoaded' || eventName === 'readystatechange') {
        // DOMContentLoaded and readystatechange events are special in that they don't require
        // shadow listeners — we dispatch them ourselves on the fragment document
        return;
      }

      // and now let's register the shadow listener onto the main window
      const mainProxyListenerTarget = fragmentTargetToMainTarget(compatListenerTarget);

      // coalesce any provided signal with the one from our abort controller so that we can
      // remove this listener when the fragment is destroyed
      const mainProxyListenerAbortSignal = AbortSignal.any(
        [fragmentAbortController.signal, options?.signal].filter((signal) => signal != null),
      );
      const mainProxyListenerOptions = {
        ...options,
        signal: mainProxyListenerAbortSignal,
      } as AddEventListenerOptions;

      // register the listener on the main window, document, <html>, or <body> target
      mainProxyListenerTarget.addEventListener(eventName, mainProxyListener, mainProxyListenerOptions);
    },
  });

  const compatRemoveEventListener = new Proxy(realmWindow.EventTarget.prototype.removeEventListener, {
    apply(originalRemoveEventListener, originalListenerTarget, argumentsList) {
      const [eventName, appListenerOrObject, optionsOrCapture] = argumentsList as Parameters<
        typeof originalRemoveEventListener
      >;

      if (!appListenerOrObject) return;

      if (!originalListenerTarget) {
        // removeEventListener can be called unbound, in which case the target is the realm window
        originalListenerTarget = realmWindow;
      }

      // if the event is a realm event, then skip everything and remove the listener directly on the realm window
      if (realmEvents.includes(eventName) && originalListenerTarget === realmWindow) {
        originalRemoveEventListener.call(realmWindow, eventName, appListenerOrObject, optionsOrCapture);
        return;
      }

      const appListener =
        typeof appListenerOrObject === 'object' ? appListenerOrObject?.handleEvent : appListenerOrObject;

      if (!appListener) {
        // this is some kind of unknown listener, possibly feature detection for passive event support
        Reflect.apply(originalRemoveEventListener, originalListenerTarget, argumentsList);
        return;
      }

      const compatListenerTarget = realmTargetToFragmentTarget(originalListenerTarget);
      const compatListeners = appToCompatListenerMap.get(appListener);

      if (!compatListeners) {
        // we never added this listener, so it likely isn't registered, pass it through just in case
        Reflect.apply(originalRemoveEventListener, originalListenerTarget, argumentsList);
        return;
      }
      const { compatListener, mainProxyListener } = compatListeners;
      const modifiedArgumentsList = [eventName, compatListener, optionsOrCapture];

      Reflect.apply(originalRemoveEventListener, compatListenerTarget, modifiedArgumentsList);
      mainWindow.removeEventListener(eventName, mainProxyListener, optionsOrCapture as EventListenerOptions);
    },
  });

  realmWindow.addEventListener = realmDocument.addEventListener = compatAddEventListener;
  realmWindow.removeEventListener = realmDocument.removeEventListener = compatRemoveEventListener;

  if (partition) {
    // `cookieStore` reads and writes the raw jar, around the scoped `document.cookie`; libraries
    // feature-detect it and fall back to `document.cookie` when it is absent.
    Object.defineProperty(realmWindow, 'cookieStore', { value: undefined, configurable: true, enumerable: true });

    // The browser fires `storage` natively at every same-origin window, the realm's included, and
    // a native `onstorage` handler would hear every partition's writes. Owning the property sends
    // the handler through the compat listener instead, where the partition filters it.
    let onstorage: ((this: Window, event: StorageEvent) => unknown) | null = null;
    realmWindow.addEventListener('storage', (event) => onstorage?.call(realmWindow, event as StorageEvent));
    Object.defineProperty(realmWindow, 'onstorage', {
      get: () => onstorage,
      set: (handler: unknown) => {
        onstorage = typeof handler === 'function' ? (handler as typeof onstorage) : null;
      },
      configurable: true,
      enumerable: true,
    });
  }

  // END: EVENT SYSTEM PATCHES

  return Object.assign(fragmentBoundary, {
    bootComplete() {
      booting = false;
    },
  });
}

/** History methods that move the user, as opposed to reading state. */
const MUTATING_HISTORY_METHODS = new Set(['pushState', 'replaceState', 'back', 'forward', 'go']);
