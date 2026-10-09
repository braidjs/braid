/**
 * Turning a fragment's redirect into something a browser can act on.
 *
 * A browser that was told not to follow a redirect hides where it was going, so for fragments that
 * opt in (`redirect: 'navigate'`) the gateway answers the document request with a `409` carrying the
 * target in a header. Everything here is pure: what the target may be, and how a login's return URL
 * is pointed back at the page the user was on.
 *
 * The target is chosen by the fragment's endpoint, and it ends up as a top-level navigation, so it
 * is only ever one of three things: a path on the host's own origin, a path inside the fragment's
 * own endpoint (mapped back to the host), or an origin the host operator listed.
 */

/** An origin the host trusts as a redirect destination — `https://login.example.com`, or `https://*.example.com`. */
export interface OriginRule {
  protocol: string;
  /** The exact hostname, or the suffix after `*.` when `wildcard` is set. */
  host: string;
  wildcard: boolean;
  port: string;
}

/** Parses `redirectOrigins`, failing at construction so a typo is not a silent refusal at 2am. */
export function parseOriginRules(origins: readonly string[]): OriginRule[] {
  return origins.map((origin) => {
    const wildcard = /^[a-z][a-z0-9+.-]*:\/\/\*\./i.test(origin);
    let url: URL;
    try {
      url = new URL(wildcard ? origin.replace('*.', '') : origin);
    } catch {
      throw new Error(`braid-gateway: redirectOrigins entry "${origin}" is not a valid origin`);
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(
        `braid-gateway: redirectOrigins entry "${origin}" must be a bare http(s) origin such as ` +
          `"https://login.example.com" or "https://*.example.com"`,
      );
    }
    return { protocol: url.protocol, host: url.hostname, wildcard, port: url.port };
  });
}

function originAllowed(url: URL, rules: readonly OriginRule[]): boolean {
  return rules.some(
    (rule) =>
      rule.protocol === url.protocol &&
      rule.port === url.port &&
      // a wildcard is subdomains only — the apex is a different thing and has to be listed
      (rule.wildcard ? url.hostname.endsWith(`.${rule.host}`) : url.hostname === rule.host),
  );
}

export interface RedirectContext {
  /** The raw `Location` the fragment answered with. */
  location: string;
  /** The URL the fragment's endpoint was asked for — what a relative `Location` is relative to. */
  fragmentRequestUrl: URL;
  /** The fragment's endpoint, when it is a URL (a function endpoint has no origin of its own). */
  endpoint: string | undefined;
  /** The request that reached the gateway: the host's origin. */
  requestUrl: URL;
  allowedOrigins: readonly OriginRule[];
}

export type RedirectResolution = { ok: true; target: string } | { ok: false; reason: string };

/** `origin + path` only. A login's query string is where its tokens and return URLs live. */
export function redactUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/**
 * A path that can only mean a path on this origin.
 *
 * `//evil.net` is a valid *path* to a URL parser (`https://host//evil.net`, or `/\evil.net`, whose
 * backslash becomes a slash) and a valid *host* to whoever reads it back as a relative URL — the
 * client does, with `new URL(target, location.href)`. Every leading slash or backslash collapses to
 * one, so nothing this module emits as a path can be read as anything else.
 */
export function hostPath(pathname: string, search = '', hash = ''): string {
  return `/${pathname.replace(/^[\\/]+/, '')}${search}${hash}`;
}

export function resolveRedirectTarget(context: RedirectContext): RedirectResolution {
  let target: URL;
  try {
    target = new URL(context.location, context.fragmentRequestUrl);
  } catch {
    return { ok: false, reason: 'its Location is not a valid URL' };
  }

  // `javascript:` and `data:` would run in the page that follows them
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { ok: false, reason: `its Location uses the "${target.protocol}" scheme` };
  }
  // credentials in a URL are for phishing, and nothing a login sends the user to needs them
  if (target.username || target.password) {
    return { ok: false, reason: 'its Location carries credentials in the URL' };
  }

  // Inside the fragment's own endpoint: the same path on the host. The mirror image of how the
  // gateway forwards requests, which is what makes `/apps/billing/login` mean `/login` to a user.
  if (context.endpoint) {
    const endpointUrl = new URL(context.endpoint);
    const basePath = endpointUrl.pathname.endsWith('/') ? endpointUrl.pathname.slice(0, -1) : endpointUrl.pathname;
    if (
      target.origin === endpointUrl.origin &&
      (!basePath || target.pathname === basePath || target.pathname.startsWith(`${basePath}/`))
    ) {
      return { ok: true, target: hostPath(target.pathname.slice(basePath.length), target.search, target.hash) };
    }
  }

  // The host's own origin — including a path under /__braid/, which is how a login that is itself
  // a fragment is reached.
  if (target.origin === context.requestUrl.origin) {
    return { ok: true, target: hostPath(target.pathname, target.search, target.hash) };
  }

  if (originAllowed(target, context.allowedOrigins)) return { ok: true, target: target.href };

  return {
    ok: false,
    reason:
      `its Location (${redactUrl(target)}) is not on this host, inside the fragment's endpoint, or in ` +
      `redirectOrigins`,
  };
}

/**
 * The page the user is on, if the request says so and it is one the gateway may send them back to.
 *
 * Same origin as the gateway only: this value is client-supplied and ends up inside a redirect, so
 * it must not be able to name anywhere else. A braid URL is not a page.
 */
export function resolveReturnUrl(
  requestUrl: URL,
  headerValue: string | null,
  referer: string | null,
): URL | null {
  for (const candidate of [headerValue, referer]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.origin === requestUrl.origin && !url.pathname.startsWith('/__braid/')) return url;
    } catch {
      // try the next one
    }
  }
  return null;
}

/**
 * Points a login's return-URL parameters at the page instead of at the fragment.
 *
 * A fragment builds `?next=` from the request it saw — its own URL, which means nothing to the
 * user. Any query parameter whose value is that URL (same path, on the fragment's origin or the
 * host's) is replaced with the page the user was on, in the same form (absolute stays absolute, a
 * path stays a path). Anything else is left exactly as it was.
 */
export function rewriteReturnUrls(
  target: string,
  returnUrl: URL | null,
  context: Pick<RedirectContext, 'fragmentRequestUrl' | 'requestUrl'> & { strippedUrl: URL },
): string {
  if (!returnUrl) return target;

  const url = new URL(target, context.requestUrl);
  if (!url.search) return target;

  const origins = new Set([context.fragmentRequestUrl.origin, context.requestUrl.origin]);
  const paths = new Set([
    context.fragmentRequestUrl.pathname,
    context.strippedUrl.pathname,
    context.requestUrl.pathname,
  ]);
  const pagePath = hostPath(returnUrl.pathname, returnUrl.search, returnUrl.hash);

  let rewritten = false;
  // Pair by pair on the raw query, so a parameter that is not being rewritten keeps its exact bytes
  // — re-serializing the whole query would change `~`, bare flags and invalid UTF-8 for an IdP that
  // never asked for it.
  const pairs = url.search.slice(1).split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;

    let value: string;
    try {
      value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    } catch {
      return pair;
    }

    const isPath = value.startsWith('/') && !value.startsWith('//');
    if (!isPath && !/^https?:\/\//i.test(value)) return pair;

    let candidate: URL;
    try {
      candidate = new URL(value, context.fragmentRequestUrl);
    } catch {
      return pair;
    }
    // A fragment served at `/` would match every `redirect_uri=<its root>`, which is an OAuth
    // callback registration and not a place to return to.
    if (candidate.pathname === '/' || !origins.has(candidate.origin) || !paths.has(candidate.pathname)) return pair;

    rewritten = true;
    return `${pair.slice(0, eq + 1)}${encodeURIComponent(isPath ? pagePath : returnUrl.href)}`;
  });

  if (!rewritten) return target;
  url.search = `?${pairs.join('&')}`;
  // keep the form the target arrived in: host-relative stays host-relative
  return /^https?:\/\//i.test(target) ? url.href : hostPath(url.pathname, url.search, url.hash);
}
