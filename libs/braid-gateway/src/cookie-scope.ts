import type { FragmentManifest } from './registry.js';

/**
 * Per-fragment cookies for partitioned fragments: the server half of `capabilities.storage`.
 *
 * Trusted fragments share the host origin, and so its cookie jar. When fragments' backends finish
 * an authorization-code login by setting a session cookie, two of them setting `session` with
 * `Path=/` overwrite each other — and a gateway that forwards the caller's cookies hands every
 * fragment every other fragment's session. For a partitioned fragment the gateway renames the
 * cookies its endpoint sets into the partition's scope, and sends it only its own.
 *
 *     Set-Cookie: session=…            →  Set-Cookie: braid$orders$session=…; Path=/
 *     Cookie: braid$orders$session=a; braid$billing$session=b; theme=dark
 *                                      →  Cookie: session=a            (to orders)
 *
 * The partition is the one `capabilities.storage` names, so fragments that share Web Storage
 * share cookies too. Fragments that do not opt in are untouched.
 *
 * The encoding is duplicated in `@braidlabs/core` (`compat/cookie-partition.ts`), which gives a
 * partitioned realm the same view through `document.cookie`; e2e/cookie-scope.e2e.ts holds the two
 * to each other.
 */

const SCOPE_MARK = 'braid$';
/** Cookie-name prefixes the browser enforces, which must stay at the front of the name. */
const BROWSER_PREFIXES = ['__Host-', '__Secure-'] as const;

/**
 * The partition a fragment's cookies and storage live in, or `null` for the shared origin.
 *
 * Compat fragments only, as on the client: a custom-element or contract fragment runs in the host
 * window, where nothing would show it its cookies under their own names again.
 */
export function storagePartitionOf(fragment: Pick<FragmentManifest, 'id' | 'capabilities' | 'adapter'>): string | null {
  if ((fragment.adapter ?? 'compat') !== 'compat') return null;
  const grant: unknown = fragment.capabilities?.storage;
  if (grant === 'partitioned') return fragment.id;
  if (grant && typeof grant === 'object') {
    const partition = (grant as { partition?: unknown }).partition;
    if (typeof partition === 'string' && partition !== '') return partition;
  }
  return null;
}

/**
 * `braid$<partition>$`, with the partition percent-encoded so it is a valid cookie-name token
 * (RFC 6265) and can never contain the `$` that ends it.
 */
export function cookieScopePrefix(partition: string): string {
  const encoded = encodeURIComponent(partition).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${SCOPE_MARK}${encoded}$`;
}

/** Splits off a `__Host-`/`__Secure-` prefix, matched without regard to case as browsers do. */
function splitBrowserPrefix(name: string): [browserPrefix: string, rest: string] {
  const prefix = BROWSER_PREFIXES.find((candidate) => name.toLowerCase().startsWith(candidate.toLowerCase()));
  return prefix ? [name.slice(0, prefix.length), name.slice(prefix.length)] : ['', name];
}

/** Whether a cookie name is in any fragment's scope. Nothing legitimate starts with the mark. */
export function isScopedCookieName(name: string): boolean {
  return splitBrowserPrefix(name.trim())[1].startsWith(SCOPE_MARK);
}

function parseCookieHeader(header: string): { name: string; cookie: string }[] {
  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((cookie) => {
      const separator = cookie.indexOf('=');
      return { name: separator === -1 ? cookie : cookie.slice(0, separator), cookie };
    });
}

/**
 * One `Set-Cookie` line, moved into the partition's scope.
 *
 * The name gains the scope; `Domain` is dropped, so the cookie is host-only; `Path` becomes `/`,
 * so it still arrives on page requests and a pierced fragment can be rendered signed-in. Every
 * other attribute is kept. A name that already looks scoped is scoped again, so an endpoint can
 * never set a cookie in another fragment's scope.
 */
export function scopeSetCookie(line: string, partition: string): string {
  const [pair, ...attributes] = line.split(';');
  const separator = pair.indexOf('=');
  // a cookie without a name (`=value`, or no `=`) is unusual enough to drop rather than guess at
  if (separator <= 0) return '';
  const [browserPrefix, name] = splitBrowserPrefix(pair.slice(0, separator).trim());
  const value = pair.slice(separator + 1);

  const kept = attributes
    .map((attribute) => attribute.trim())
    .filter((attribute) => attribute !== '' && !/^(domain|path)\s*(=|$)/i.test(attribute));

  return [`${browserPrefix}${cookieScopePrefix(partition)}${name}=${value}`, 'Path=/', ...kept].join('; ');
}

/**
 * The `Cookie` header a partitioned fragment's endpoint receives: its own cookies under the names
 * its endpoint gave them, plus — only when `includeHost` (the deployment's `forwardCredentials`
 * rule) — the host's unscoped cookies. Never another fragment's. `null` when nothing is left.
 */
export function scopeRequestCookies(header: string | null, partition: string, includeHost: boolean): string | null {
  if (!header) return null;
  const own = cookieScopePrefix(partition);
  const mine: string[] = [];
  const mineNames = new Set<string>();
  const host: { name: string; cookie: string }[] = [];

  for (const { name: rawName, cookie } of parseCookieHeader(header)) {
    const [browserPrefix, name] = splitBrowserPrefix(rawName);
    if (name.startsWith(own)) {
      const ownName = `${browserPrefix}${name.slice(own.length)}`;
      mine.push(`${ownName}${cookie.slice(rawName.length)}`);
      mineNames.add(ownName);
    } else if (!name.startsWith(SCOPE_MARK) && includeHost) {
      host.push({ name: rawName, cookie });
    }
  }

  // the fragment's own cookie wins over a host cookie of the same name: parsers take the first
  // occurrence, and the host's usually came first
  const out = [...mine, ...host.filter(({ name }) => !mineNames.has(name)).map(({ cookie }) => cookie)];
  return out.length > 0 ? out.join('; ') : null;
}

/**
 * The caller's cookies for a *shared* fragment under `forwardCredentials`: everything but the
 * partitioned fragments' scoped cookies, which belong to their own fragments alone.
 */
export function withoutScopedCookies(header: string | null): string | null {
  if (!header) return null;
  const out = parseCookieHeader(header)
    .filter(({ name }) => !isScopedCookieName(name))
    .map(({ cookie }) => cookie);
  return out.length > 0 ? out.join('; ') : null;
}

/**
 * Rewrites every `Set-Cookie` on `headers` into the partition's scope, in place, and drops
 * `Clear-Site-Data`, with which one fragment's logout would wipe every other fragment's cookies
 * and storage along with its own.
 */
export function scopeResponseCookies(headers: Headers, partition: string): void {
  headers.delete('clear-site-data');
  const lines = headers.getSetCookie();
  if (lines.length === 0) return;
  headers.delete('set-cookie');
  for (const line of lines) {
    const scoped = scopeSetCookie(line, partition);
    if (scoped) headers.append('set-cookie', scoped);
  }
}
