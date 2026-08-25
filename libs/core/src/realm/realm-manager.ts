import { BraidError } from '../errors.js';
import { isDevMode } from '../config.js';
import {
  BRAID_ADAPTER_META,
  BRAID_ADAPTER_OPTIONS_META,
  BRAID_PROTOCOL_META,
  BRAID_PROTOCOL_VERSION,
  braidFragmentUrl,
  braidRealmUrl,
} from '../protocol.js';

/**
 * Realm manager. A realm is the isolated JS context a fragment executes in — a hidden
 * same-origin iframe, the only browser primitive providing a synchronous, DOM-capable second
 * JavaScript context.
 *
 * Realm kinds:
 * - `compat-http` — boots from a real `http:` URL inside the gateway namespace
 *   (`/__braid/frag/:id/…`), because only a real URL can make the global `location`/`history`
 *   illusion truthful (`history.replaceState` cannot rewrite a `blob:` document to an `http:`
 *   URL). The stub's `<base>` keeps relative subresource requests inside the namespace; the
 *   fragment's route-url illusion is restored via `replaceState` once the iframe loads.
 * - `contract-blob` — boots from a runtime-authored `blob:` URL; zero interaction with the
 *   joint session history. Not shipped in this build (compat-only).
 * - `sandbox` — a real sandboxed cross-origin iframe for the untrusted tier. Created by
 *   `createSandboxRealm()` rather than here, because a cross-origin frame cannot satisfy
 *   `RealmHandle` — see that module's header.
 */
export type RealmKind = 'contract-blob' | 'compat-http' | 'sandbox';

/** An import map, scoped to a single realm's document. */
export interface RealmImportMap {
  imports?: Record<string, string>;
  scopes?: Record<string, Record<string, string>>;
}

export interface RealmInit {
  fragmentId: string;
  /** The fragment's logical route URL (pathname + search) restored after boot. */
  routeUrl: string;
  /** Whether the fragment's navigation is bound to the host window's navigation. */
  bound: boolean;
  /** Abort signal owned by the fragment instance; disposal is wired to it. */
  signal: AbortSignal;
  /**
   * The fragment's own import map (contract-blob realms only). Because every fragment gets its
   * own realm document, each gets its own import map for free — which is how two fragments can
   * ship different majors of the same dependency without a shared resolution namespace.
   */
  importMap?: RealmImportMap;
  /**
   * The realm document's `<base>`, overriding the gateway namespace.
   *
   * This one option is what makes contract mode gateway-free. A compat realm's relative URLs must
   * resolve into `/__braid/frag/:id/…` because the gateway is proxying them; a contract fragment
   * fetches from its own origin directly, so its base is simply its own entry's directory and no
   * host-origin namespace has to exist.
   */
  baseHref?: string;
}

export interface RealmHandle {
  readonly kind: RealmKind;
  /** The fragment this realm belongs to. */
  readonly fragmentId: string;
  readonly window: Window & typeof globalThis;
  readonly document: Document;
  /**
   * The adapter name the gateway stamped onto the realm stub from the fragment's manifest.
   * Null for realms the runtime authors itself (there is no stub to read it from).
   */
  readonly manifestAdapter: string | null;
  /**
   * Adapter-specific options the gateway stamped onto the realm stub from the manifest — which
   * custom element to mount, which entry module to evaluate. Empty for realms with no stub.
   */
  readonly adapterOptions: Readonly<Record<string, unknown>>;
  /** Loads and evaluates a module by URL inside the realm. */
  evaluate(entryUrl: string): Promise<void>;
  /** Evaluates module source inside the realm. Resolves once the module has run. */
  evaluateModule(source: string): Promise<boolean>;
  dispose(): void;
}

export async function createRealm(kind: RealmKind, init: RealmInit): Promise<RealmHandle> {
  switch (kind) {
    case 'compat-http':
      return createCompatHttpRealm(init);
    case 'contract-blob':
      return createContractBlobRealm(init);
    case 'sandbox':
      /**
       * Not a failure any more — a redirection. The untrusted tier is built, but it is not a
       * `RealmHandle`: `window`, `document` and `evaluate()` are same-origin capabilities that a
       * cross-origin frame cannot offer, and faking them is the illusion that tier exists to
       * refuse. See `createSandboxRealm`.
       */
      throw new BraidError('untrusted fragments are not created through createRealm()', {
        fragmentId: init.fragmentId,
        stage: 'realm-boot',
        fixHint: 'mount it as <fragment-slot trust="untrusted" src="https://…">, or call createSandboxRealm() directly',
      });
    default:
      throw new BraidError(`unknown realm kind "${kind}"`, {
        fragmentId: init.fragmentId,
        stage: 'realm-boot',
      });
  }
}

/**
 * Creates a contract-mode realm from a `blob:` URL the runtime authors itself.
 *
 * Booting from a blob costs no network round trip, needs no gateway stub, and — because the
 * realm never navigates — has **zero interaction with the joint session history**, which
 * eliminates the whole class of back/forward corruption that http-booted realms have to work
 * around. The realm document carries the fragment's `<base>` (so relative URLs resolve into the
 * fragment's namespace) and the fragment's own import map.
 *
 * Contract-mode code never reads realm globals — it receives `env.location`/`env.document` — so
 * the realm has no illusion to maintain and needs no patches. That is exactly why blob realms
 * are safe here and forbidden in compat mode, where `history.replaceState` must be able to
 * rewrite the realm's URL to the fragment's route (which a blob document cannot do).
 */
async function createContractBlobRealm(init: RealmInit): Promise<RealmHandle> {
  const { fragmentId, importMap } = init;

  // The base href must be absolute: a blob: URL has an opaque path, so a root-relative href
  // has nothing meaningful to resolve against.
  const baseHref = init.baseHref ?? new URL(braidFragmentUrl(fragmentId, '/'), location.origin).href;

  const realmDocumentHtml =
    `<!doctype html><meta charset="utf-8"><title>Braid realm: ${escapeHtml(fragmentId)}</title>` +
    `<meta name="${BRAID_PROTOCOL_META}" content="${BRAID_PROTOCOL_VERSION}">` +
    `<base href="${escapeHtml(baseHref)}">` +
    (importMap ? `<script type="importmap">${JSON.stringify(importMap)}</script>` : '');

  const blobUrl = URL.createObjectURL(new Blob([realmDocumentHtml], { type: 'text/html' }));

  const iframe = document.createElement('iframe');
  iframe.hidden = true;
  iframe.setAttribute('aria-hidden', 'true');
  iframe.src = blobUrl;
  iframe.name = `braid:${fragmentId}`;

  const { promise: loaded, resolve: resolveLoaded, reject: rejectLoaded } = Promise.withResolvers<void>();

  iframe.addEventListener('load', () => resolveLoaded(), { once: true });
  iframe.addEventListener(
    'error',
    () =>
      rejectLoaded(
        new BraidError('the contract realm document failed to load', {
          fragmentId,
          stage: 'realm-boot',
          fixHint: `allow blob: in the host page's frame-src content security policy`,
        }),
      ),
    { once: true },
  );

  document.body.appendChild(iframe);

  try {
    await loaded;
  } finally {
    // the document has been created from it; the URL itself is no longer needed
    URL.revokeObjectURL(blobUrl);
  }

  const realmWindow = iframe.contentWindow as (Window & typeof globalThis) | null;
  const realmDocument = iframe.contentDocument;

  if (!realmWindow || !realmDocument) {
    throw new BraidError('the contract realm is not same-origin with the host page', {
      fragmentId,
      stage: 'realm-boot',
      fixHint: `allow blob: in the host page's frame-src content security policy`,
    });
  }

  const handle = createRealmHandle('contract-blob', iframe, realmWindow, realmDocument, null, {}, init);

  if (isDevMode()) {
    installContractRealmGuidance(realmDocument, fragmentId);
  }

  if (isDevMode()) {
    console.debug(`[braid:${fragmentId}] contract-blob realm ready`, { baseHref });
  }

  init.signal.addEventListener('abort', () => handle.dispose(), { once: true });

  return handle;
}

/**
 * Reads the adapter's manifest options off the realm stub.
 *
 * Malformed JSON is a gateway bug rather than something an app can fix, so it warns and yields
 * nothing instead of failing the boot — an adapter that needs an option reports its own absence
 * with a far more useful message than a parse error would.
 */
function readAdapterOptions(realmDocument: Document, fragmentId: string): Readonly<Record<string, unknown>> {
  const raw = realmDocument
    .querySelector(`meta[name="${BRAID_ADAPTER_OPTIONS_META}"]`)
    ?.getAttribute('content');

  if (!raw) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    console.warn(`[braid:${fragmentId}] the gateway sent unparsable adapter options; ignoring them`);
    return {};
  }
}

/**
 * Builds the shared part of a realm handle: module evaluation and disposal.
 *
 * Module evaluation injects a module script built with the realm's *native* `createElement` and
 * appended to the realm's own body — a script created in another document does not execute, and
 * a script cloned from a parser-created one carries the "already started" flag and never runs.
 */
function createRealmHandle(
  kind: RealmKind,
  iframe: HTMLIFrameElement,
  realmWindow: Window & typeof globalThis,
  realmDocument: Document,
  manifestAdapter: string | null,
  adapterOptions: Readonly<Record<string, unknown>>,
  init: RealmInit,
): RealmHandle {
  // captured before any facade or dev guidance is spliced into the document's prototype chain
  const nativeCreateElement = Document.prototype.createElement.bind(realmDocument) as Document['createElement'];
  const realmBody = realmDocument.body;

  let evaluationCounter = 0;

  async function evaluateModule(source: string): Promise<boolean> {
    const callbackName = `__braidModuleDone${evaluationCounter++}__`;
    const { promise, resolve, reject } = Promise.withResolvers<boolean>();

    Object.defineProperty(realmWindow, callbackName, {
      configurable: true,
      value: () => resolve(true),
    });

    const script = nativeCreateElement('script');
    script.type = 'module';
    // import declarations are hoisted, so appending the completion call after the fragment's
    // own source is valid regardless of what the source imports
    script.textContent = `${source}\n;window.${callbackName}?.();`;

    const onError = (event: ErrorEvent) =>
      reject(
        new BraidError(`module evaluation failed in the fragment's realm: ${event.message}`, {
          fragmentId: init.fragmentId,
          stage: 'adapter-mount',
          cause: event.error,
        }),
      );

    realmWindow.addEventListener('error', onError as EventListener, { once: true });
    script.addEventListener('error', () =>
      reject(
        new BraidError('a module script failed to load in the fragment realm', {
          fragmentId: init.fragmentId,
          stage: 'adapter-mount',
          fixHint: 'check that the module url resolves inside the fragment namespace',
        }),
      ),
    );

    realmBody.appendChild(script);

    try {
      return await promise;
    } finally {
      realmWindow.removeEventListener('error', onError as EventListener);
      Reflect.deleteProperty(realmWindow, callbackName);
    }
  }

  return {
    kind,
    fragmentId: init.fragmentId,
    window: realmWindow,
    document: realmDocument,
    manifestAdapter,
    adapterOptions,
    evaluateModule,
    async evaluate(entryUrl: string) {
      // resolved against the realm's <base>, so it lands in the fragment's namespace
      await evaluateModule(`import ${JSON.stringify(new URL(entryUrl, realmDocument.baseURI).href)};`);
    },
    dispose() {
      iframe.remove();
    },
  };
}

/**
 * Dev-only guidance for contract realms: warns once when fragment code reads
 * the realm's `document` instead of the `env` it was handed, and points at the contract.
 *
 * Known limitation, verified against the platform: `window.location` and `document.location`
 * are `[LegacyUnforgeable]` — own, non-configurable properties that cannot be intercepted in
 * any realm, ours included. So a fragment reaching for `location` gets the blob URL with no
 * warning. This is the same platform rule that makes blob realms unable to fake an http URL,
 * and it is why compat mode keeps http realms.
 */
function installContractRealmGuidance(realmDocument: Document, fragmentId: string): void {
  const originalPrototype = Object.getPrototypeOf(realmDocument);
  let warned = false;

  const guidanceProxy = new Proxy(originalPrototype, {
    get(target, property, receiver) {
      if (!warned && typeof property === 'string' && property !== 'location') {
        warned = true;
        console.warn(
          `[braid:${fragmentId}] a contract-mode fragment read 'document.${property}' from its realm.\n` +
            `Realm globals are explicitly out of contract: use the env your adapter received ` +
            `(env.document, env.root, env.location) so the fragment keeps working when the isolation backend changes.`,
        );
      }
      return Reflect.get(target, property, receiver);
    },
  });

  Object.setPrototypeOf(realmDocument, guidanceProxy);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function createCompatHttpRealm(init: RealmInit): Promise<RealmHandle> {
  const { fragmentId, routeUrl, bound } = init;
  const routeSrcUrl = new URL(routeUrl, document.baseURI);

  if (routeSrcUrl.origin !== location.origin) {
    throw new BraidError(`route url "${routeUrl}" is not same-origin with the host page`, {
      fragmentId,
      stage: 'realm-boot',
      fixHint: 'compat fragments are served through the gateway on the host origin; use a path, not a cross-origin url',
    });
  }

  /**
   * Create the iframe we'll load the fragment's JS context into, hidden from the viewport.
   * The src must be set before the element is inserted to avoid double loads (and, in Firefox,
   * spurious history records for iframes that get their src one task after insertion).
   */
  const iframe = document.createElement('iframe');
  iframe.hidden = true;
  // the realm stub has its own namespace, so the fragment's asset URLs carry no header variance
  iframe.src = braidRealmUrl(fragmentId, routeSrcUrl.pathname, routeSrcUrl.search);
  iframe.name = `braid:${fragmentId}`;

  const { promise: loaded, resolve: resolveLoaded, reject: rejectLoaded } = Promise.withResolvers<void>();

  let alreadyLoaded = false;
  let pendingHardNavigationHref: string | null = null;

  iframe.addEventListener('load', () => {
    if (alreadyLoaded) {
      // iframe reload detected: the fragment app attempted to reload or hard-navigate.
      if (bound) {
        // Workaround for a Safari (v26) bfcache bug: after a hard navigation away and a
        // back-button return, Safari recreates the iframe with the old src but feeds it the
        // new document. Intercept the first reload, park the target href, restore the
        // host's location into the iframe, then complete the hard navigation on the host.
        if (pendingHardNavigationHref) {
          location.href = pendingHardNavigationHref;
        } else {
          pendingHardNavigationHref = iframe.contentWindow!.location.href;
          iframe.contentWindow!.location.href = location.href;
        }
      } else {
        console.warn(`[braid:${fragmentId}] unbound fragment reload detected — fragment content is stale`);
      }
      return;
    }
    alreadyLoaded = true;

    try {
      verifyRealmStub(iframe, fragmentId);
      // Restore the fragment's route-url illusion: the iframe was loaded from the gateway
      // namespace, but the fragment's JS context must observe the route url as its location.
      // The stub's <base> element is unaffected by replaceState and keeps relative url
      // resolution inside the namespace.
      iframe.contentWindow!.history.replaceState(null, '', routeSrcUrl.pathname + routeSrcUrl.search);
      resolveLoaded();
    } catch (error) {
      rejectLoaded(error);
    }
  });

  document.body.appendChild(iframe);
  await loaded;

  if (isDevMode()) {
    console.debug(`[braid:${fragmentId}] compat-http realm ready`, { src: iframe.src });
  }

  const handle = createRealmHandle(
    'compat-http',
    iframe,
    iframe.contentWindow as Window & typeof globalThis,
    iframe.contentDocument!,
    iframe.contentDocument!.querySelector(`meta[name="${BRAID_ADAPTER_META}"]`)?.getAttribute('content') ?? null,
    readAdapterOptions(iframe.contentDocument!, fragmentId),
    init,
  );

  init.signal.addEventListener('abort', () => handle.dispose(), { once: true });

  return handle;
}

/**
 * Verifies the loaded iframe document is the gateway's realm stub for this protocol version.
 * This replaces title-check heuristics with explicit version negotiation: mismatches and
 * misconfigurations produce named errors with the likely fix.
 */
function verifyRealmStub(iframe: HTMLIFrameElement, fragmentId: string): void {
  const stubDocument = iframe.contentDocument;

  if (!stubDocument) {
    throw new BraidError(`the realm document for "${iframe.src}" is not accessible`, {
      fragmentId,
      stage: 'realm-boot',
      fixHint:
        'ensure the gateway response is not delivered with "X-Frame-Options: deny" and is same-origin with the host page',
    });
  }

  const protocol = stubDocument.querySelector(`meta[name="${BRAID_PROTOCOL_META}"]`)?.getAttribute('content');

  if (protocol !== BRAID_PROTOCOL_VERSION) {
    throw new BraidError(
      protocol
        ? `gateway speaks braid protocol "${protocol}" but this client speaks "${BRAID_PROTOCOL_VERSION}"`
        : `the document loaded from "${iframe.src}" is not a braid realm stub`,
      {
        fragmentId,
        stage: 'realm-boot',
        fixHint: protocol
          ? 'upgrade @braidlabs/core and @braidlabs/gateway to the same package version'
          : `ensure the braid gateway is mounted in front of this app and has a manifest registered for fragment id "${fragmentId}"`,
      },
    );
  }
}
