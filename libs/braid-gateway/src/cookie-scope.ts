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

/** The partition a fragment's cookies and storage live in, or `null` for the shared origin. */
export function storagePartitionOf(fragment: Pick<FragmentManifest, 'id' | 'capabilities'>): string | null {
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

function splitBrowserPrefix(name: string): [browserPrefix: string, rest: string] {
  const prefix = BROWSER_PREFIXES.find((candidate) => name.startsWith(candidate));
  return prefix ? [prefix, name.slice(prefix.length)] : ['', name];
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
  const out: string[] = [];

  for (const part of header.split(';')) {
    const cookie = part.trim();
    if (!cookie) continue;
    const separator = cookie.indexOf('=');
    const rawName = separator === -1 ? cookie : cookie.slice(0, separator);
    const rest = separator === -1 ? '' : cookie.slice(separator);
    const [browserPrefix, name] = splitBrowserPrefix(rawName);

    if (name.startsWith(own)) out.push(`${browserPrefix}${name.slice(own.length)}${rest}`);
    else if (!name.startsWith(SCOPE_MARK) && includeHost) out.push(cookie);
  }

  return out.length > 0 ? out.join('; ') : null;
}

/** Rewrites every `Set-Cookie` on `headers` into the partition's scope, in place. */
export function scopeResponseCookies(headers: Headers, partition: string): void {
  const lines = headers.getSetCookie();
  if (lines.length === 0) return;
  headers.delete('set-cookie');
  for (const line of lines) {
    const scoped = scopeSetCookie(line, partition);
    if (scoped) headers.append('set-cookie', scoped);
  }
}
