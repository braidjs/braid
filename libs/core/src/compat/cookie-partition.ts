/**
 * `document.cookie` for a partitioned fragment: the realm's view of the cookies the gateway scopes.
 *
 * The gateway renames a partitioned fragment's cookies on the way out (`session` becomes
 * `braid$<partition>$session`) and back on the way in — see `@braidlabs/gateway`'s
 * `cookie-scope.ts`, which this mirrors. Without the same view here, a script-readable cookie the
 * fragment's backend set (a CSRF token the fragment echoes in a header, an OIDC client's
 * cookie-mode state) would show up renamed and be lost to the fragment's own code; and a cookie the
 * fragment writes from script would land unscoped, where every other fragment can read and
 * overwrite it.
 *
 * Reads return the partition's cookies under their own names plus the host's unscoped ones; writes
 * go into the partition. Another partition's cookies are never visible. The encoding is duplicated
 * from the gateway (the two packages share no modules); e2e/cookie-scope.e2e.ts holds them together.
 */

const SCOPE_MARK = 'braid$';
const BROWSER_PREFIXES = ['__Host-', '__Secure-'] as const;

/** `braid$<partition>$`, percent-encoded into a cookie-name token. Same as the gateway's. */
export function cookieScopePrefix(partition: string): string {
  const encoded = encodeURIComponent(partition).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${SCOPE_MARK}${encoded}$`;
}

/** Splits off a `__Host-`/`__Secure-` prefix, matched without regard to case as browsers do. */
function splitBrowserPrefix(name: string): [browserPrefix: string, rest: string] {
  const prefix = BROWSER_PREFIXES.find((candidate) => name.toLowerCase().startsWith(candidate.toLowerCase()));
  return prefix ? [name.slice(0, prefix.length), name.slice(prefix.length)] : ['', name];
}

export interface CookieAccessor {
  get(): string;
  set(value: string): void;
}

/** Wraps the realm document's native cookie accessor in the partition's view. */
export function partitionCookie(native: CookieAccessor, partition: string): CookieAccessor {
  const own = cookieScopePrefix(partition);

  return {
    get() {
      const mine: string[] = [];
      const mineNames = new Set<string>();
      const host: { name: string; cookie: string }[] = [];
      for (const part of native.get().split(';')) {
        const cookie = part.trim();
        if (!cookie) continue;
        const separator = cookie.indexOf('=');
        const rawName = separator === -1 ? cookie : cookie.slice(0, separator);
        const rest = separator === -1 ? '' : cookie.slice(separator);
        const [browserPrefix, name] = splitBrowserPrefix(rawName);
        if (name.startsWith(own)) {
          const ownName = `${browserPrefix}${name.slice(own.length)}`;
          mine.push(`${ownName}${rest}`);
          mineNames.add(ownName);
        } else if (!name.startsWith(SCOPE_MARK)) {
          host.push({ name: rawName, cookie });
        }
      }
      // the fragment's own cookie wins over a host cookie of the same name, as at its backend
      return [...mine, ...host.filter(({ name }) => !mineNames.has(name)).map(({ cookie }) => cookie)].join('; ');
    },

    set(value) {
      const [pair, ...attributes] = String(value).split(';');
      const separator = pair.indexOf('=');
      if (separator <= 0) return;
      const [browserPrefix, name] = splitBrowserPrefix(pair.slice(0, separator).trim());
      const kept = attributes
        .map((attribute) => attribute.trim())
        .filter((attribute) => attribute !== '' && !/^(domain|path)\s*(=|$)/i.test(attribute));
      native.set([`${browserPrefix}${own}${name}=${pair.slice(separator + 1)}`, 'Path=/', ...kept].join('; '));
    },
  };
}

/** The realm document's own `cookie` accessor, captured before the facade replaces its prototype. */
export function nativeCookieAccessor(realmDocument: Document): CookieAccessor {
  for (let object: object | null = realmDocument; object; object = Object.getPrototypeOf(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, 'cookie');
    if (descriptor?.get && descriptor.set) {
      return { get: () => descriptor.get!.call(realmDocument) as string, set: (value) => descriptor.set!.call(realmDocument, value) };
    }
  }
  throw new Error('braid: this browser has no document.cookie');
}
