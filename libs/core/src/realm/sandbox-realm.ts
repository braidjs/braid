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
const TOP_NAVIGATION_HINT =
  'use "allow-top-navigation-by-user-activation" if the fragment genuinely needs to navigate the page';
const REFUSED_SANDBOX_TOKENS = new Map([
  ['allow-top-navigation', TOP_NAVIGATION_HINT],
  ['allow-top-navigation-to-custom-protocols', TOP_NAVIGATION_HINT],
  /**
   * The same navigation by another door: a popup that escapes the sandbox can set
   * `window.opener.top.location` and swap the host page for a lookalike.
   */
  [
    'allow-popups-to-escape-sandbox',
    '"allow-popups" alone lets the fragment open windows; they stay sandboxed, which is the point',
  ],
  /**
   * The token that turns the sandbox off. With it the frame keeps a real origin: a `javascript:`
   * src, or a navigation to a URL on the host's origin, then runs with the host's own authority.
   * The handshake works without it, so nothing on this tier needs it.
   */
  [
    'allow-same-origin',
    'leave it out: the untrusted tier connects from an opaque origin, which is what keeps it isolated',
  ],
]);

/**
 * Every token the HTML standard defines. Anything else is refused rather than passed through: the
 * browser ignores a token it does not know, so a typo would silently grant less than intended — or,
 * as browsers add tokens, silently grant something nobody reviewed.
 */
const KNOWN_SANDBOX_TOKENS = new Set([
  'allow-downloads',
  'allow-forms',
  'allow-modals',
  'allow-orientation-lock',
  'allow-pointer-lock',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-presentation',
  'allow-same-origin',
  'allow-scripts',
  'allow-storage-access-by-user-activation',
  'allow-top-navigation',
  'allow-top-navigation-by-user-activation',
  'allow-top-navigation-to-custom-protocols',
]);

/** Loopback hosts, where plain `http:` is how local development serves a second origin. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

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
  /** The origin the fragment's src names. The frame itself runs in an opaque origin, never this one. */
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

  /**
   * Only a network scheme can name another origin. `javascript:`, `data:` and `blob:` have an
   * opaque origin, which never equals the host's, so the comparison below would wave them through
   * — and a `javascript:` src in a frame granted `allow-same-origin` runs in the host's origin.
   */
  const secure = url.protocol === 'https:';
  const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (!secure && !loopback) {
    throw new BraidError(`the untrusted tier loads fragments over https, and "${src}" is not an https url`, {
      fragmentId,
      stage: 'slot-config',
      fixHint: 'serve the fragment from its own https origin; plain http is accepted only on localhost',
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

  // The browser splits the attribute on whitespace and matches tokens case-insensitively, so this
  // must too — or "ALLOW-TOP-NAVIGATION" and "allow-popups allow-top-navigation" slip past.
  const normalized = requested.flatMap((entry) => String(entry).toLowerCase().split(/\s+/).filter(Boolean));

  for (const token of normalized) {
    if (!KNOWN_SANDBOX_TOKENS.has(token)) {
      throw new BraidError(`"${token}" is not a sandbox token`, {
        fragmentId,
        stage: 'slot-config',
        fixHint: 'sandbox tokens are the allow-* keywords the HTML standard defines, e.g. "allow-popups"',
      });
    }
    const refusal = REFUSED_SANDBOX_TOKENS.get(token);
    if (refusal !== undefined) {
      throw new BraidError(`the sandbox token "${token}" is never granted to an untrusted fragment`, {
        fragmentId,
        stage: 'slot-config',
        fixHint: refusal,
      });
    }
    tokens.add(token);
  }

  return [...tokens];
}

/**
 * Creates the frame, waits for it to load, and establishes the message channel.
 *
 * The guest announces itself and the host answers that window with the port. The host listens
 * before the frame is attached, so there is no ordering to race: however fast the guest's script
 * runs, its announcement finds a listener.
 */
export async function createSandboxRealm(init: SandboxRealmInit): Promise<SandboxRealm> {
  const { fragmentId, src, container, signal } = init;

  const origin = assertCrossOrigin(src, fragmentId);
  const tokens = resolveSandboxTokens(init.sandboxTokens, fragmentId);
  const instance = `${fragmentId}:${Date.now().toString(36)}`;

  const frame = document.createElement('iframe');
  // The absolute URL that was checked, not the string: `src` would resolve against
  // `document.baseURI`, which a `<base>` element can point somewhere `location.href` does not.
  frame.src = new URL(src, location.href).href;
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

  const channel = new MessageChannel();

  const dispose = () => {
    channel.port1.close();
    frame.remove();
  };
  signal.addEventListener('abort', dispose, { once: true });

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let connected = false;

  /**
   * The guest speaks first, and the host answers that window and no other.
   *
   * A sandboxed frame without `allow-same-origin` has an opaque origin. A message targeted at the
   * fragment's origin is never delivered to it, and its own messages arrive with origin `"null"`.
   * The origin cannot identify it, so the window does: `event.source` is set by the browser, and
   * only this frame's window can be `frame.contentWindow`. The reply goes to that window with `'*'`,
   * the only target an opaque origin accepts, in the same task the guest's message arrived in, so it
   * reaches the document that asked.
   */
  const onWindowMessage = (event: MessageEvent) => {
    if (event.source === null || event.source !== frame.contentWindow) return;
    if (event.origin !== 'null') return;
    if ((event.data as SandboxReadyMessage | undefined)?.braid !== SANDBOX_READY) return;
    if (connected) return;
    connected = true;
    const message: SandboxConnectMessage = { braid: SANDBOX_CONNECT, v: 1, fragmentId, instance };
    (event.source as Window).postMessage(message, '*', [channel.port2]);
    resolve();
  };

  // Listening before the frame exists, so a guest that announces itself at once is not missed.
  window.addEventListener('message', onWindowMessage);
  container.append(frame);

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
