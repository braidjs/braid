import { BraidError } from '../errors.js';

/**
 * The untrusted tier: a real cross-origin iframe, with a good protocol on it.
 *
 * That sentence is the honest description and it is worth leading with, because Braid's own
 * documentation has been quietly implying otherwise. The trusted tier's advantages — one document,
 * one layout, one accessibility tree, SSR piercing, printing, DOM projection — are consequences of
 * *sharing a document*, and none of them survive a boundary the browser enforces. This tier gives
 * up every one of them. In exchange it gives the only thing the trusted tier cannot: separation
 * that holds when the code on the other side has gone bad rather than merely gone wrong.
 *
 * So this is not a better realm. It is a different bet, and the architecture is explicit about
 * which one you are making:
 *
 * | | trusted (`compat-http`, `contract-blob`) | untrusted (`sandbox`) |
 * | --- | --- | --- |
 * | isolation | namespace, not security | browser-enforced |
 * | DOM | projected into the host document | stays in its own document |
 * | cookies/storage | the host's | its own, partitioned |
 * | composition | gateway namespaces, piercing, compat facade | none of it applies |
 *
 * **Why this is not a `RealmHandle`.** That interface exposes `window`, `document`, `evaluate()`
 * and `evaluateModule()` — every one of which is a same-origin capability. Making a cross-origin
 * realm implement it would mean either throwing from four members or faking them, and faking them
 * is precisely the "manufacture the illusion that two documents are one" move this tier exists to
 * refuse. A different thing gets a different type.
 */

/** The connect message the host posts into the frame, carrying the port. */
export const SANDBOX_CONNECT = 'braid:connect';
/** The announcement a guest posts to its parent when it is ready to receive one. */
export const SANDBOX_READY = 'braid:ready';

export interface SandboxConnectMessage {
  braid: typeof SANDBOX_CONNECT;
  v: 1;
  fragmentId: string;
  instance: string;
}

export interface SandboxReadyMessage {
  braid: typeof SANDBOX_READY;
  v: 1;
}

/**
 * Sandbox tokens granted to every untrusted fragment.
 *
 * `allow-scripts` because a fragment that cannot run scripts is not an application. `allow-forms`
 * because a form post is the least surprising thing a page does. Everything else is an opt-in the
 * host records in the registry, so the grant lives with the person who decided to make it.
 */
export const DEFAULT_SANDBOX_TOKENS = ['allow-scripts', 'allow-forms'] as const;

/**
 * Tokens that are never granted, whatever the manifest says.
 *
 * `allow-top-navigation` lets an embedded frame navigate the whole page — the classic way an
 * embedded advert becomes a phishing redirect. The `-by-user-activation` variant is the one to
 * grant if you need it, and it must be granted deliberately rather than inherited from a broad
 * "let this fragment navigate" instinct.
 */
const REFUSED_SANDBOX_TOKENS = new Set(['allow-top-navigation']);

export interface SandboxRealmInit {
  fragmentId: string;
  /** The fragment's URL. Must be cross-origin to the host — see `assertCrossOrigin`. */
  src: string;
  /** Where the frame is mounted. The untrusted tier renders visibly; it projects nothing. */
  container: ShadowRoot | HTMLElement;
  signal: AbortSignal;
  /** Additional sandbox tokens from the fragment's manifest. */
  sandboxTokens?: readonly string[];
  /** Permissions-Policy features to delegate, e.g. `['clipboard-write']`. */
  permissions?: readonly string[];
  /** How long to wait for the frame to load before failing. */
  loadTimeoutMs?: number;
}

export interface SandboxRealm {
  readonly kind: 'sandbox';
  readonly fragmentId: string;
  /** The frame element, so a host can size it. Its contents are not reachable from here. */
  readonly frame: HTMLIFrameElement;
  /** The fragment's origin, for pinning every message that crosses. */
  readonly origin: string;
  /** The host end of the message channel. */
  readonly port: MessagePort;
  dispose(): void;
}

const LOAD_TIMEOUT_MS = 15_000;

/**
 * Refuses a same-origin URL for the untrusted tier.
 *
 * This is the single most important check in the file. `sandbox="allow-scripts allow-same-origin"`
 * on a **same-origin** frame is a sandbox that isn't one — the frame can reach into the host
 * document and remove its own sandbox attribute — and the mistake is easy to make because the
 * markup looks locked down. Refusing at the source, rather than trusting the token list, means the
 * dangerous combination cannot be assembled from a manifest edit.
 */
export function assertCrossOrigin(src: string, fragmentId: string): string {
  let url: URL;
  try {
    url = new URL(src, location.href);
  } catch (cause) {
    throw new BraidError(`"${src}" is not a valid url for an untrusted fragment`, {
      fragmentId,
      stage: 'slot-config',
      cause,
      fixHint: 'untrusted fragments are addressed by absolute url, e.g. src="https://vendor.example.com/widget"',
    });
  }

  if (url.origin === location.origin) {
    throw new BraidError(`the untrusted tier requires a cross-origin url, and "${url.origin}" is this host's origin`, {
      fragmentId,
      stage: 'slot-config',
      fixHint:
        'serve the fragment from a different origin — a same-origin sandbox is not a security ' +
        'boundary, because the framed document can reach the host and clear its own sandbox attribute',
    });
  }

  return url.origin;
}

/** Resolves the sandbox token list, refusing the ones that would undo the sandbox. */
export function resolveSandboxTokens(requested: readonly string[] = [], fragmentId: string): string[] {
  const tokens = new Set<string>(DEFAULT_SANDBOX_TOKENS);

  for (const token of requested) {
    if (REFUSED_SANDBOX_TOKENS.has(token)) {
      throw new BraidError(`the sandbox token "${token}" is never granted to an untrusted fragment`, {
        fragmentId,
        stage: 'slot-config',
        fixHint: `use "${token}-by-user-activation" if the fragment genuinely needs to navigate the page`,
      });
    }
    tokens.add(token);
  }

  return [...tokens];
}

/**
 * Creates the frame, waits for it to load, and establishes the message channel.
 *
 * The connect handshake is deliberately tolerant of ordering. The frame's `load` event and the
 * guest's own script registering its listener race, and which wins depends on cache state — so the
 * host posts on load *and* answers a guest that announces itself, and the guest announces itself
 * whether or not it has already been posted to. Either order converges; neither has to be the fast
 * one.
 */
export async function createSandboxRealm(init: SandboxRealmInit): Promise<SandboxRealm> {
  const { fragmentId, src, container, signal } = init;

  const origin = assertCrossOrigin(src, fragmentId);
  const tokens = resolveSandboxTokens(init.sandboxTokens, fragmentId);
  const instance = `${fragmentId}:${Date.now().toString(36)}`;

  const frame = document.createElement('iframe');
  frame.src = src;
  frame.setAttribute('sandbox', tokens.join(' '));
  frame.setAttribute('part', 'frame');
  frame.style.cssText = 'display:block;border:0;width:100%;height:100%';

  /**
   * Permissions-Policy delegation is a *deny* list by default: an unlisted feature is unavailable
   * inside the frame regardless of what the fragment's own origin allows. Setting `allow` to the
   * empty string when nothing is granted is not redundant — it makes the denial explicit in the
   * markup, where someone auditing the page will see it.
   */
  frame.setAttribute('allow', (init.permissions ?? []).join('; '));

  // Progressive: where supported, the frame gets an ephemeral, per-page storage and cookie jar, so
  // an untrusted fragment cannot correlate this user with the same fragment on another site.
  if ('credentialless' in HTMLIFrameElement.prototype) {
    frame.setAttribute('credentialless', '');
  }

  container.append(frame);

  const channel = new MessageChannel();

  const dispose = () => {
    channel.port1.close();
    frame.remove();
  };
  signal.addEventListener('abort', dispose, { once: true });

  const post = () => {
    const message: SandboxConnectMessage = { braid: SANDBOX_CONNECT, v: 1, fragmentId, instance };
    /**
     * The target origin is the fragment's exact origin, never `'*'`.
     *
     * With `'*'` the port would be delivered to whatever document happens to occupy the frame — and
     * an untrusted fragment that navigated itself elsewhere between load and this call would hand a
     * live channel into the host to a document nobody vetted.
     */
    frame.contentWindow?.postMessage(message, origin, [channel.port2]);
  };

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let connected = false;

  const onWindowMessage = (event: MessageEvent) => {
    // Origin-pinned inbound as well as outbound: a `braid:ready` from any other origin is some
    // other page on the tab talking, and must not cause the host to hand out a port.
    if (event.origin !== origin) return;
    if ((event.data as SandboxReadyMessage | undefined)?.braid !== SANDBOX_READY) return;
    if (connected) return;
    connected = true;
    post();
    resolve();
  };

  window.addEventListener('message', onWindowMessage);

  const onLoad = () => {
    if (connected) return;
    connected = true;
    post();
    resolve();
  };
  frame.addEventListener('load', onLoad, { once: true });

  const timeout = setTimeout(() => {
    reject(
      new BraidError(`the untrusted fragment at "${src}" did not load within ${init.loadTimeoutMs ?? LOAD_TIMEOUT_MS}ms`, {
        fragmentId,
        stage: 'realm-boot',
        fixHint: 'check the url, and that the fragment origin does not refuse framing via X-Frame-Options or CSP frame-ancestors',
      }),
    );
  }, init.loadTimeoutMs ?? LOAD_TIMEOUT_MS);

  try {
    await promise;
  } finally {
    clearTimeout(timeout);
    window.removeEventListener('message', onWindowMessage);
    frame.removeEventListener('load', onLoad);
  }

  return {
    kind: 'sandbox',
    fragmentId,
    frame,
    origin,
    port: channel.port1,
    dispose,
  };
}
