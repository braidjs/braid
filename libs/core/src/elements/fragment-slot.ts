import { BraidError } from '../errors.js';
import { braidDocumentUrl, BRAID_FRAGMENT_ID_HEADER } from '../protocol.js';
import { createRealm } from '../realm/realm-manager.js';
import { contractAdapter } from '../adapters/contract-adapter.js';
import { resolveAdapter } from '../adapters/adapter.js';
import { createFragmentEnv } from '../env/create-env.js';
import { getBraidConfig, isDevMode } from '../config.js';
import { braidContext } from '../context/context-bus.js';
import { createBoundaryChannel } from '../weave/channel.js';
import { createSameRealmBackingPair } from '../weave/same-realm-backing.js';
import { weaveId } from '../weave/envelope.js';
import { performHostHandshake } from '../weave/handshake.js';
import { attachContextRouter } from '../weave/context-bridge.js';
import { FRAGMENT_EVENT, FragmentEventPayload, PROPS_CHANGED } from '../weave/messages.js';
import { HostLiveness, LivenessState, startFragmentBeats, startHostLiveness } from '../weave/liveness.js';
import { CloseReason, DIRTY, DirtyPayload, closeAndDispose } from '../weave/closing.js';
import { negotiateContract } from '../weave/contract.js';
import { createSandboxRealm } from '../realm/sandbox-realm.js';
import { createPortBacking } from '../weave/port-backing.js';
import { FragmentCapabilities, readCapabilities, resolveCapabilities } from '../weave/capabilities.js';

/**
 * What the slot reports about its fragment.
 *
 * The original four are all still here and still mean what they meant — `ready` in particular is
 * kept as the name for "mounted, first beat not yet observed", which the liveness machine calls
 * `connecting`. Renaming it would have broken every host checking `slot.state === 'ready'` in
 * exchange for a word.
 *
 * The new three are the ones `ready` used to have to cover on its own:
 *
 * - `healthy` — beating.
 * - `unobservable` — the tab is hidden, so the host has stopped being able to tell. Not a fault.
 * - `suspect` → `gone` — beats stopped while the fragment should have been running.
 */
export type FragmentSlotState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error'
  | 'closing'
  | 'healthy'
  | 'unobservable'
  | 'suspect'
  | 'gone';

/** `connecting` is reported as `ready`; every other liveness state carries its own name. */
export function slotStateFor(liveness: LivenessState): FragmentSlotState {
  return liveness === 'connecting' ? 'ready' : liveness;
}

/**
 * Finds server-rendered fragment content the gateway pierced into a slot.
 *
 * Deliberately a direct-children scan rather than `querySelector(':scope > braid-document')`:
 * `:scope` has no element to match against on a ShadowRoot, so that selector silently never
 * matches. The failure mode is invisible from inside the page — the slot just quietly re-fetches
 * and replaces identical content — so it is worth a named helper and a test.
 */
export function findPiercedContentRoot(shadowRoot: ShadowRoot | null): HTMLElement | null {
  if (!shadowRoot) return null;
  for (const child of shadowRoot.children) {
    if (child.tagName === 'BRAID-DOCUMENT') return child as HTMLElement;
  }
  return null;
}

/**
 * The slot's own styles, including the fallback rules.
 *
 * `gone` and `error` hide the fragment's content and reveal whatever the host put in the fallback
 * slot. Note what is *not* hidden: `suspect`. A fragment that is merely slow keeps its rendered
 * content on screen, because replacing a working-if-sluggish UI with an apology is a worse outcome
 * than a moment of unresponsiveness — and suspicion is designed to be recoverable.
 */
export const SLOT_STYLES =
  ':host, braid-document, braid-html, braid-body { display: block; } braid-head { display: none; }' +
  'slot[name="fallback"] { display: none; }' +
  ':host([state="gone"]) braid-document, :host([state="error"]) braid-document { display: none; }' +
  ':host([state="gone"]) slot[name="fallback"], :host([state="error"]) slot[name="fallback"] { display: block; }';

/**
 * Ensures the shadow root can present host-provided fallback content:
 *
 * ```html
 * <fragment-slot name="checkout"><p slot="fallback">Checkout is unavailable.</p></fragment-slot>
 * ```
 *
 * Added separately from the styles because pierced fragments arrive with a shadow root the gateway
 * wrote, which has content but no fallback slot — and a fallback that only worked for
 * client-rendered fragments would be missing from exactly the pages that server-render because
 * their first paint matters.
 */
export function ensureFallbackSlot(shadowRoot: ShadowRoot): void {
  if (shadowRoot.querySelector('slot[name="fallback"]')) return;

  if (!shadowRoot.querySelector('style')) {
    const styleSheet = document.createElement('style');
    styleSheet.textContent = SLOT_STYLES;
    shadowRoot.prepend(styleSheet);
  }

  const fallback = document.createElement('slot');
  fallback.name = 'fallback';
  shadowRoot.append(fallback);
}

/**
 * `<fragment-slot>` — the custom element a host renders to mount a fragment.
 *
 * ```html
 * <fragment-slot name="checkout"></fragment-slot>
 * ```
 *
 * - `name` — the fragment id in the gateway registry (required).
 * - `src` — optional route url for the fragment. When absent, the fragment is *bound*: it
 *   follows the host page's location and participates in host navigation.
 * - `props` — JSON attribute (or the `props` property) passed to the fragment instance.
 *
 * Events: `braid:ready`, `braid:error` (detail includes stage + fix hint), `braid:event`
 * (fragment → host).
 *
 * The slot uses only its own shadow root and its own elements — the host page is never patched.
 */
export class FragmentSlot extends HTMLElement {
  static get observedAttributes() {
    return ['name', 'src', 'props'];
  }

  #state: FragmentSlotState = 'idle';
  #props: Record<string, unknown> = {};
  /** Host end of this instance's boundary channel; undefined between teardown and the next boot. */
  #channel: ReturnType<typeof createBoundaryChannel> | undefined;
  #liveness: HostLiveness | undefined;
  #abortController: AbortController | undefined;
  /**
   * The in-flight close, if any.
   *
   * Teardown became asynchronous when it became a negotiation, and `disconnectedCallback` is not.
   * So a close runs on after the element has left the DOM, and the next boot waits for it — which
   * is also what stops a completing close from clearing a shadow root the *next* instance has
   * already rendered into.
   */
  #closing: Promise<void> | undefined;
  /** Identifies which close is current, so a superseded one does not clear the DOM on its way out. */
  #closingToken: symbol | undefined;
  #dirty: string | null = null;
  #booted = false;
  #bootScheduled = false;
  /** Set by reload(): a reload must re-fetch, never re-adopt the pierced content. */
  #forceFetch = false;

  get state(): FragmentSlotState {
    return this.#state;
  }

  /**
   * Sets the state, reflects it to the `state` attribute, and announces the transition.
   *
   * The attribute is what lets a host show fallback content in CSS alone — `:host([state="gone"])`
   * — which matters because the page most in need of a fallback is the one whose JavaScript is
   * already in trouble.
   */
  #setState(next: FragmentSlotState): void {
    if (this.#state === next) return;
    const previous = this.#state;
    this.#state = next;
    this.setAttribute('state', next);
    this.dispatchEvent(new CustomEvent('braid:state', { detail: { state: next, previous, fragmentId: this.name } }));
  }

  get name(): string {
    return this.getAttribute('name') ?? '';
  }

  /**
   * The fragment's unsaved-work declaration, or null.
   *
   * Readable synchronously because the only place a host can act on it — a `beforeunload`
   * handler — cannot await anything. Braid never installs that handler itself:
   *
   * ```ts
   * addEventListener('beforeunload', (event) => {
   *   if (slot.dirty) event.preventDefault();
   * });
   * ```
   */
  get dirty(): string | null {
    return this.#dirty;
  }

  get props(): Record<string, unknown> {
    return this.#props;
  }

  set props(value: Record<string, unknown>) {
    this.#props = structuredClone(value ?? {});
    // Cloned again on the way out. The slot's copy is the host's to mutate; a fragment holding a
    // live reference to it would see changes the host never announced — the asymmetry that made
    // props behave unlike context before Weave.
    this.#channel?.send(PROPS_CHANGED, { props: structuredClone(this.#props) });
  }

  attributeChangedCallback(attribute: string, oldValue: string | null, newValue: string | null) {
    if (attribute === 'props') {
      try {
        this.props = newValue ? JSON.parse(newValue) : {};
      } catch (error) {
        console.warn(`[braid:${this.name}] ignoring unparsable props attribute`, error);
      }
    } else if (attribute === 'name' && oldValue !== newValue) {
      if (this.isConnected && this.#booted) {
        void this.reload();
      } else if (this.isConnected && !this.#booted && !this.#bootScheduled) {
        this.#bootScheduled = true;
        queueMicrotask(() => {
          this.#bootScheduled = false;
          if (this.isConnected && !this.#booted) {
            this.#booted = true;
            void this.#boot();
          }
        });
      }
    }
  }

  connectedCallback() {
    if (this.#booted || this.#bootScheduled) {
      return;
    }
    this.#bootScheduled = true;
    queueMicrotask(() => {
      this.#bootScheduled = false;
      if (!this.isConnected || this.#booted) {
        return;
      }
      this.#booted = true;
      void this.#boot();
    });
  }

  disconnectedCallback() {
    this.#bootScheduled = false;
    // Not awaited, because `disconnectedCallback` cannot be. The close runs on after the element
    // has left the DOM — which is exactly the window a flush needs, and the reason the fragment's
    // realm is not disposed until the negotiation finishes.
    void this.#teardown('unmount');
    this.#booted = false;
  }

  async reload(): Promise<void> {
    await this.#teardown('reload');
    this.#forceFetch = true;
    await this.#boot();
  }

  /**
   * Closes the current instance: ask, wait for the deadline at most, then dispose.
   *
   * Resolves once the instance is fully gone, so `reload()` and the next `#boot()` can wait on it.
   */
  #teardown(reason: CloseReason): Promise<void> {
    const channel = this.#channel;
    const abortController = this.#abortController;

    this.#liveness?.stop();
    this.#liveness = undefined;
    this.#channel = undefined;
    this.#abortController = undefined;

    // Nothing mounted: the pre-Weave synchronous path, still the right one for an idle slot.
    if (!channel || !abortController) {
      abortController?.abort();
      this.shadowRoot?.replaceChildren();
      this.#setState('idle');
      return Promise.resolve();
    }

    this.#setState('closing');

    const token = Symbol('braid:closing');
    this.#closingToken = token;

    const closed = (async () => {
      const result = await closeAndDispose({
        channel,
        fragmentId: this.name,
        reason,
        // Runs only after the fragment has acknowledged, or the deadline has passed. Aborting any
        // earlier would cut off the flush this negotiation exists to allow.
        dispose: () => {
          abortController.abort();
          channel.close();
        },
      });

      this.#setDirty(null);

      this.dispatchEvent(
        new CustomEvent('braid:closed', {
          detail: { fragmentId: this.name, reason, ...result },
        }),
      );

      // Only the close that is still the current one clears the DOM. A boot that overtook this
      // close has already rendered into the shadow root, and wiping it here would blank a fragment
      // that had just successfully mounted.
      if (this.#closingToken === token) {
        this.shadowRoot?.replaceChildren();
        this.#setState('idle');
        this.#closing = undefined;
        this.#closingToken = undefined;
      }
    })();

    this.#closing = closed;
    return closed;
  }

  #setDirty(reason: string | null): void {
    if (this.#dirty === reason) return;
    this.#dirty = reason;
    this.dispatchEvent(new CustomEvent('braid:dirty', { detail: { fragmentId: this.name, reason } }));
  }

  async #boot(): Promise<void> {
    const fragmentId = this.name;

    // A close still negotiating owns the shadow root until it finishes. Booting into it first
    // would render content that the completing close would then clear.
    await this.#closing;

    try {
      if (!fragmentId) {
        /**
         * Every tier needs a name, but only one of them needs a *registry entry*.
         *
         * The name is this fragment's identity to the runtime: it appears in every `BraidError`, it
         * is what capability grants are looked up by, and it is what distinguishes two instances in
         * a trace. Contract and untrusted fragments have no gateway registration at all, so a hint
         * that told their authors to register one sent them looking for a file that should not
         * exist.
         */
        const registered = this.getAttribute('adapter') !== 'contract' && this.getAttribute('trust') !== 'untrusted';
        throw new BraidError('the <fragment-slot> element is missing its name attribute', {
          fragmentId: '<unnamed>',
          stage: 'slot-config',
          fixHint: registered
            ? '<fragment-slot name="..."> must name a fragment registered in the gateway'
            : '<fragment-slot name="..."> needs a name to identify this fragment in errors and ' +
              'capability grants — it is not looked up in a registry on this tier',
        });
      }

      this.#setState('loading');

      if (this.getAttribute('trust') === 'untrusted') {
        await this.#bootUntrusted(fragmentId);
        return;
      }

      if (this.getAttribute('adapter') === 'contract') {
        await this.#bootContract(fragmentId);
        return;
      }

      const abortController = new AbortController();
      this.#abortController = abortController;
      const signal = abortController.signal;

      // src present → standalone fragment pinned to that route; absent → bound to host location
      const src = this.getAttribute('src');
      const bound = !src;
      const routeUrl = src ?? location.pathname + location.search;
      const routeSrcUrl = new URL(routeUrl, document.baseURI);

      /**
       * Pierced fragments arrive with their content already in the DOM: the gateway wrote a
       * declarative shadow root into this element, and the browser parsed it at the same time
       * as the rest of the page. Adopting it is strictly better than fetching — the
       * content is already painted, and re-fetching it would replace live DOM with identical
       * DOM. `#forceFetch` is set by reload(), which must go back to the network.
       */
      const piercedContentRoot = this.#forceFetch ? null : findPiercedContentRoot(this.shadowRoot);

      let shadowRoot: ShadowRoot;
      let contentRoot: HTMLElement;

      if (piercedContentRoot) {
        shadowRoot = this.shadowRoot!;
        contentRoot = piercedContentRoot;
      } else {
        shadowRoot = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
        const styleSheet = document.createElement('style');
        styleSheet.textContent = SLOT_STYLES;
        contentRoot = document.createElement('braid-document');
        shadowRoot.replaceChildren(styleSheet, contentRoot);
      }

      ensureFallbackSlot(shadowRoot);

      /**
       * Boot the realm and fetch the fragment's document at the same time, unless it was
       * already pierced in. Both go through the gateway's namespaces, addressed by id.
       *
       * Which adapter a fragment uses is only known once the realm stub has loaded, so the
       * document request is started optimistically and its failure is held rather than thrown:
       * an adapter that builds its own UI from an entry module (a lone custom element, say) has
       * no document to fetch, and must not be reported as broken for not serving one.
       */
      const [htmlResult, realm] = await Promise.all([
        piercedContentRoot
          ? Promise.resolve({ ok: true as const, html: null })
          : this.#fetchFragmentHtml(fragmentId, routeSrcUrl, signal).then(
              (html) => ({ ok: true as const, html }),
              (error: unknown) => ({ ok: false as const, error }),
            ),
        createRealm('compat-http', { fragmentId, routeUrl, bound, signal }),
      ]);

      // The gateway stamps the manifest-declared adapter onto the realm stub; unknown adapters
      // fail as a named error, and an undeclared adapter resolves to the default (compat).
      const adapter = resolveAdapter(realm.manifestAdapter, fragmentId);

      if (!htmlResult.ok && adapter.needsDocument !== false) throw htmlResult.error;
      const html = htmlResult.ok ? htmlResult.html : null;

      /**
       * The boundary channel for this instance.
       *
       * Both ends live in the host realm on the trusted tier — the "fragment end" is the object
       * graph the realm holds — so the same-realm backing dispatches directly with no clone. The
       * shape is nonetheless identical to what Phase 5 will run over a `MessagePort`, which is the
       * only reason building the transport before the tier that needs it is worth anything.
       */
      const instance = weaveId();
      const backings = createSameRealmBackingPair();
      const hostChannel = createBoundaryChannel({ backing: backings.host, fragmentId, instance, signal });
      const fragmentChannel = createBoundaryChannel({ backing: backings.fragment, fragmentId, instance, signal });
      this.#channel = hostChannel;

      hostChannel.on(DIRTY, (payload) => {
        this.#setDirty(((payload ?? {}) as DirtyPayload).reason ?? null);
      });

      hostChannel.on(FRAGMENT_EVENT, (payload) => {
        const { type, detail } = (payload ?? {}) as FragmentEventPayload;
        this.dispatchEvent(new CustomEvent('braid:event', { detail: { type, detail }, bubbles: true }));
      });

      const { env, opened } = createFragmentEnv({
        contentRoot,
        shadowRoot,
        routeUrl,
        channel: fragmentChannel,
        fragmentId,
        signal,
      });

      /**
       * Terms are agreed before the adapter mounts, not after.
       *
       * A fragment that cannot be given the context it declared should never have been booted, and
       * discovering that after its framework has rendered means tearing down a live UI instead of
       * showing a fallback in an empty slot.
       */
      const hostContract = getBraidConfig().contract;
      const capabilities = this.#capabilitiesFor(fragmentId, readCapabilities(realm.adapterOptions));

      await performHostHandshake({
        channel: hostChannel,
        fragmentId,
        instance,
        ...(hostContract === undefined ? {} : { hostContract }),
        negotiate: (host, fragment) =>
          negotiateContract({ host, fragment, schemaFor: (key) => braidContext.schemaFor(key) }),
        onBridged: (bridges) => {
          /**
           * A bridged connection is a working one, so this is an event and not an error — but it is
           * announced rather than logged quietly, because `discards` names fields this fragment
           * will never see, and a screen rendered confidently without them looks correct.
           */
          this.dispatchEvent(new CustomEvent('braid:bridged', { detail: { fragmentId, bridges } }));
          if (isDevMode()) {
            for (const bridge of bridges) {
              console.debug(
                `[braid:${fragmentId}] context "${bridge.key}" bridged v${bridge.from} → v${bridge.to}` +
                  (bridge.discards.length > 0 ? `, discarding ${bridge.discards.join(', ')}` : ''),
              );
            }
          }
        },
        assertReachable: (versions) => {
          for (const [key, as] of Object.entries(versions)) braidContext.assertReachable(key, as, fragmentId);
        },
        openWith: (contextVersions) => ({
          context: attachContextRouter({
            bus: braidContext,
            channel: hostChannel,
            fragmentId,
            contextVersions,
            ...(capabilities === undefined ? {} : { capabilities }),
            signal,
          }),
          props: structuredClone(this.#props),
        }),
      });
      await opened;

      if (signal.aborted) return;

      await adapter.boot({
        fragmentId,
        shadowRoot,
        contentRoot,
        realm,
        html,
        pierced: Boolean(piercedContentRoot),
        routeUrl,
        bound,
        env,
        signal,
      });

      if (signal.aborted) return;

      this.#setState('ready');
      this.dispatchEvent(new CustomEvent('braid:ready', { detail: { fragmentId } }));

      /**
       * Liveness starts only once the adapter has mounted.
       *
       * Starting it at handshake would put a deadline on a fragment that is still evaluating its
       * framework bundle, and the honest name for that state is `loading` — the host knows exactly
       * what it is waiting for, so it has nothing to be suspicious about yet.
       */
      this.#liveness = startHostLiveness({
        channel: hostChannel,
        instance,
        signal,
        onState: (liveness) => this.#setState(slotStateFor(liveness)),
      });

      // Scheduled on the realm's own event loop, never the host's — a beat is only evidence if it
      // had to be produced by the thing being asked about. See `BeatScheduler`.
      startFragmentBeats({
        channel: fragmentChannel,
        scheduler: realm.window,
        signal,
      });
      if (isDevMode()) {
        console.debug(`[braid:${fragmentId}] ready`, { slot: this });
      }
    } catch (error) {
      if (this.#abortController?.signal.aborted) return;

      this.#setState('error');
      const braidError =
        error instanceof BraidError
          ? error
          : new BraidError(error instanceof Error ? error.message : String(error), {
              fragmentId,
              stage: 'adapter-mount',
              cause: error,
            });

      console.error(braidError);
      this.dispatchEvent(
        new CustomEvent('braid:error', {
          detail: {
            fragmentId: braidError.fragmentId,
            stage: braidError.stage,
            fixHint: braidError.fixHint,
            error: braidError,
          },
        }),
      );
    }
  }

  /**
   * Mounts a contract fragment, with **no gateway involved at all**.
   *
   * ```html
   * <fragment-slot name="checkout" adapter="contract" entry="https://checkout.example.com/main.js">
   * ```
   *
   * The host declares the entry in markup because a gateway-free host has nowhere else to declare
   * it — there is no registry to read and no realm stub to stamp. That is the whole point: no
   * middleware on the host origin, no namespace routing, no HTML rewriting, no document fetch. A
   * statically hosted SPA can compose contract fragments.
   *
   * Everything else is shared with the trusted compat path — the same handshake, contract
   * negotiation, capabilities, liveness and teardown — because all of it was built against the
   * boundary rather than against compat's machinery.
   */
  async #bootContract(fragmentId: string): Promise<void> {
    const entry = this.getAttribute('entry');
    if (!entry) {
      throw new BraidError('a contract fragment needs an entry module', {
        fragmentId,
        stage: 'slot-config',
        fixHint: '<fragment-slot adapter="contract" entry="https://checkout.example.com/main.js">',
      });
    }

    const abortController = new AbortController();
    this.#abortController = abortController;
    const signal = abortController.signal;

    const src = this.getAttribute('src');
    const routeUrl = src ?? location.pathname + location.search;

    const shadowRoot = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    const styleSheet = document.createElement('style');
    styleSheet.textContent = SLOT_STYLES;
    const contentRoot = document.createElement('braid-document');
    shadowRoot.replaceChildren(styleSheet, contentRoot);
    ensureFallbackSlot(shadowRoot);

    // The realm's base is the entry's own directory, not a gateway namespace: a contract fragment
    // fetches its assets from wherever it is hosted, directly.
    const entryUrl = new URL(entry, document.baseURI);
    const realm = await createRealm('contract-blob', {
      fragmentId,
      routeUrl,
      bound: !src,
      signal,
      baseHref: new URL('./', entryUrl).href,
    });

    const instance = weaveId();
    const backings = createSameRealmBackingPair();
    const hostChannel = createBoundaryChannel({ backing: backings.host, fragmentId, instance, signal });
    const fragmentChannel = createBoundaryChannel({ backing: backings.fragment, fragmentId, instance, signal });
    this.#channel = hostChannel;

    hostChannel.on(DIRTY, (payload) => this.#setDirty(((payload ?? {}) as DirtyPayload).reason ?? null));
    hostChannel.on(FRAGMENT_EVENT, (payload) => {
      const { type, detail } = (payload ?? {}) as FragmentEventPayload;
      this.dispatchEvent(new CustomEvent('braid:event', { detail: { type, detail }, bubbles: true }));
    });

    const { env, opened } = createFragmentEnv({
      contentRoot,
      shadowRoot,
      routeUrl,
      channel: fragmentChannel,
      fragmentId,
      signal,
    });

    const hostContract = getBraidConfig().contract;
    const capabilities = this.#capabilitiesFor(fragmentId, undefined);

    await performHostHandshake({
      channel: hostChannel,
      fragmentId,
      instance,
      ...(hostContract === undefined ? {} : { hostContract }),
      negotiate: (host, fragment) =>
        negotiateContract({ host, fragment, schemaFor: (key) => braidContext.schemaFor(key) }),
      onBridged: (bridges) =>
        void this.dispatchEvent(new CustomEvent('braid:bridged', { detail: { fragmentId, bridges } })),
      assertReachable: (versions) => {
        for (const [key, as] of Object.entries(versions)) braidContext.assertReachable(key, as, fragmentId);
      },
      openWith: (contextVersions) => ({
        context: attachContextRouter({
          bus: braidContext,
          channel: hostChannel,
          fragmentId,
          contextVersions,
          ...(capabilities === undefined ? {} : { capabilities }),
          signal,
        }),
        props: structuredClone(this.#props),
      }),
    });
    await opened;

    await contractAdapter.boot({
      fragmentId,
      shadowRoot,
      contentRoot,
      realm,
      html: null,
      pierced: false,
      routeUrl,
      bound: !src,
      // Resolved against the document, so a relative `entry` works for a fragment served from the
      // host's own origin — the static-host case, where there is no gateway *and* no second origin.
      entry: entryUrl.href,
      env,
      signal,
    });

    if (signal.aborted) return;

    this.#setState('ready');
    this.dispatchEvent(new CustomEvent('braid:ready', { detail: { fragmentId } }));

    this.#liveness = startHostLiveness({
      channel: hostChannel,
      instance,
      signal,
      onState: (liveness) => this.#setState(slotStateFor(liveness)),
    });

    startFragmentBeats({ channel: fragmentChannel, scheduler: realm.window, signal });
  }

  /**
   * Mounts an untrusted fragment: a visible cross-origin frame, and a port.
   *
   * Almost nothing from the trusted path applies here, and the shape of this method is the honest
   * expression of that. There is no gateway namespace, no document fetch, no HTML rewriting, no
   * pierced content to adopt, no adapter, and no realm to evaluate a module in — the fragment is a
   * whole application at its own origin, and the only things that cross are the ones Weave carries.
   *
   * What it shares with the trusted path is everything built in Phases 1–4: the same handshake, the
   * same contract negotiation, the same liveness, the same negotiated teardown. That is the return
   * on having built the transport before the tier that needed it.
   */
  async #bootUntrusted(fragmentId: string): Promise<void> {
    const src = this.getAttribute('src');
    if (!src) {
      throw new BraidError('an untrusted fragment needs an explicit cross-origin src', {
        fragmentId,
        stage: 'slot-config',
        fixHint: '<fragment-slot trust="untrusted" src="https://vendor.example.com/widget">',
      });
    }

    const abortController = new AbortController();
    this.#abortController = abortController;
    const signal = abortController.signal;

    const shadowRoot = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    const styleSheet = document.createElement('style');
    styleSheet.textContent = SLOT_STYLES;
    shadowRoot.replaceChildren(styleSheet);
    ensureFallbackSlot(shadowRoot);

    /**
     * On this tier the capability block is not advisory: `sandbox` and `permissions` become real
     * iframe attributes that the browser enforces, and `context.read` decides what enters the
     * fragment's mirror at all.
     */
    // No realm stub on this tier — there is no gateway — so `initBraid({ capabilities })` is the
    // registry, and the slot's own attributes are the least authoritative source.
    const capabilities = this.#capabilitiesFor(fragmentId, undefined, {
      ...(this.#sandboxTokens() === undefined ? {} : { sandbox: this.#sandboxTokens()! }),
      ...(this.#permissions() === undefined ? {} : { permissions: this.#permissions()! }),
    });

    const { promise: mounted, resolve: markMounted } = Promise.withResolvers<void>();

    const realm = await createSandboxRealm({
      fragmentId,
      src,
      container: shadowRoot,
      signal,
      ...(capabilities?.sandbox === undefined ? {} : { sandboxTokens: capabilities.sandbox }),
      ...(capabilities?.permissions === undefined ? {} : { permissions: capabilities.permissions }),
    });

    const instance = weaveId();
    const hostChannel = createBoundaryChannel({
      backing: createPortBacking(realm.port),
      fragmentId,
      instance,
      signal,
    });
    this.#channel = hostChannel;

    hostChannel.on(DIRTY, (payload) => {
      this.#setDirty(((payload ?? {}) as DirtyPayload).reason ?? null);
    });

    hostChannel.on(FRAGMENT_EVENT, (payload) => {
      const { type, detail } = (payload ?? {}) as FragmentEventPayload;
      this.dispatchEvent(new CustomEvent('braid:event', { detail: { type, detail }, bubbles: true }));
    });

    /**
     * Listening starts *before* the handshake; judging starts at `mounted`.
     *
     * A cross-origin guest begins beating the moment it is open, and nothing orders that against the
     * host finishing its own work — so registering the handler afterwards drops the opening beat and
     * leaves a healthy fragment in `connecting` for a full interval. Arming the deadline this early
     * would be the opposite mistake, which is exactly what `armAfter` separates.
     */
    this.#liveness = startHostLiveness({
      channel: hostChannel,
      instance,
      signal,
      armAfter: mounted,
      onState: (liveness) => this.#setState(slotStateFor(liveness)),
    });

    const hostContract = getBraidConfig().contract;

    await performHostHandshake({
      channel: hostChannel,
      fragmentId,
      instance,
      ...(hostContract === undefined ? {} : { hostContract }),
      negotiate: (host, fragment) =>
        negotiateContract({ host, fragment, schemaFor: (key) => braidContext.schemaFor(key) }),
      onBridged: (bridges) => {
        this.dispatchEvent(new CustomEvent('braid:bridged', { detail: { fragmentId, bridges } }));
      },
      assertReachable: (versions) => {
        for (const [key, as] of Object.entries(versions)) braidContext.assertReachable(key, as, fragmentId);
      },
      openWith: (contextVersions) => ({
        context: attachContextRouter({
          bus: braidContext,
          channel: hostChannel,
          fragmentId,
          contextVersions,
          ...(capabilities === undefined ? {} : { capabilities }),
          signal,
        }),
        props: structuredClone(this.#props),
      }),
    });

    if (signal.aborted) return;

    this.#setState('ready');
    this.dispatchEvent(new CustomEvent('braid:ready', { detail: { fragmentId } }));

    /**
     * No `startFragmentBeats` here. The guest schedules its own, in its own document, on its own
     * event loop — which is stronger evidence than the trusted tier can offer, where the beat comes
     * from a hidden frame rather than from the application itself.
     */
    markMounted();
  }

  /** Resolves this fragment's capabilities. See `resolveCapabilities` for the precedence. */
  #capabilitiesFor(
    fragmentId: string,
    fromStub: FragmentCapabilities | undefined,
    fromSlot?: FragmentCapabilities,
  ): FragmentCapabilities | undefined {
    return resolveCapabilities([fromStub, getBraidConfig().capabilities?.[fragmentId], fromSlot]);
  }

  /** `sandbox="allow-popups allow-downloads"` on the slot: additive tokens, host-declared. */
  #sandboxTokens(): string[] | undefined {
    const value = this.getAttribute('sandbox');
    return value ? value.split(/\s+/).filter(Boolean) : undefined;
  }

  /** `allow="clipboard-write"` on the slot: Permissions-Policy features delegated into the frame. */
  #permissions(): string[] | undefined {
    const value = this.getAttribute('allow');
    return value ? value.split(/;/).map((entry) => entry.trim()).filter(Boolean) : undefined;
  }

  async #fetchFragmentHtml(fragmentId: string, routeSrcUrl: URL, signal: AbortSignal): Promise<string> {
    // the document namespace: the gateway prepares this exactly as it prepares pierced content
    const documentUrl = braidDocumentUrl(fragmentId, routeSrcUrl.pathname, routeSrcUrl.search);

    let response: Response;
    try {
      response = await fetch(documentUrl, {
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          [BRAID_FRAGMENT_ID_HEADER]: fragmentId,
        },
        signal,
      });
    } catch (error) {
      throw new BraidError(`fetching the fragment's html from "${documentUrl}" failed`, {
        fragmentId,
        stage: 'fragment-fetch',
        cause: error,
        fixHint: 'ensure the braid gateway is mounted in front of this app and reachable from the browser',
      });
    }

    if (!response.ok) {
      throw new BraidError(
        `the gateway responded with HTTP ${response.status} for "${documentUrl}"`,
        {
          fragmentId,
          stage: 'fragment-fetch',
          fixHint:
            response.status === 404
              ? `register a manifest for fragment id "${fragmentId}" in the gateway registry`
              : `check the gateway logs for fragment id "${fragmentId}"`,
        },
      );
    }

    return response.text();
  }
}
