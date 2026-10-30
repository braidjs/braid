/**
 * Subresource URLs that fragment *code* sets, resolved the way the gateway resolves the ones in
 * fragment *markup*.
 *
 * A fragment's elements live in the host page's document, so a relative URL on one resolves
 * against the host page. The gateway re-roots the subresource URLs in a fragment's markup into
 * `/__braid/frag/<id>/…` for exactly that reason (`rewriteSubresourceUrls` in the gateway's
 * `rewriter/transforms.ts`), but a URL set from script — `frame.src = 'silent-renew.html'`,
 * `img.src = 'logo.png'` — arrives after the markup and loaded a host URL instead. This applies the
 * same rule at the moment it is set, so a fragment behaves as it does standalone.
 *
 * The element/attribute table and the rule are duplicated from the gateway: the two packages share
 * no modules. Navigation targets (`a[href]`, `form[action]`) are left alone, as there.
 */

/** Attributes that point at a subresource the fragment owns, per element (as in the gateway). */
export const SUBRESOURCE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = Object.assign(Object.create(null), {
  audio: ['src'],
  embed: ['src'],
  iframe: ['src'],
  img: ['src', 'srcset'],
  input: ['src'],
  link: ['href'],
  object: ['data'],
  script: ['src'],
  source: ['src', 'srcset'],
  track: ['src'],
  use: ['href'],
  video: ['src', 'poster'],
});

const NAMESPACE = /^(.*?\/__braid\/frag\/[^/]+)(\/.*)?$/;

/**
 * The fragment's namespace root (`/__braid/frag/<id>`, behind any gateway `basePath`), read off
 * the realm document's base URL, which points into it. `null` when it does not.
 */
export function fragmentRootOf(realmBaseUrl: string): string | null {
  try {
    return NAMESPACE.exec(new URL(realmBaseUrl).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * One URL mapped into the fragment's namespace — the gateway's `namespaceUrl`, exactly: resolved
 * against the fragment's own `<base href>` (default `/`) as its document would, then re-rooted.
 * Absolute URLs, protocol-relative ones, pure fragments and URLs already inside the namespace are
 * returned as they are.
 */
export function fragmentSubresourceUrl(value: string, fragmentRoot: string, fragmentBaseHref = '/'): string {
  const url = value.trim();
  if (!url || url.startsWith('#') || url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return value;
  // already re-rooted — markup the gateway prepared, an attribute read back and set again
  if (url === fragmentRoot || url.startsWith(`${fragmentRoot}/`)) return value;

  const resolved = new URL(url, `http://braid.invalid${fragmentBaseHref.startsWith('/') ? fragmentBaseHref : `/${fragmentBaseHref}`}`);
  return `${fragmentRoot}${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/** Each candidate of a `srcset`, mapped, with its descriptor kept (split as the gateway splits). */
export function fragmentSrcset(value: string, fragmentRoot: string, fragmentBaseHref = '/'): string {
  return value
    .split(',')
    .map((candidate) => {
      const match = /^(\s*)(\S+)(\s*.*)$/.exec(candidate);
      if (!match) return candidate;
      const [, leading, url, descriptor] = match;
      return `${leading}${fragmentSubresourceUrl(url, fragmentRoot, fragmentBaseHref)}${descriptor}`;
    })
    .join(',');
}

/** Where a stamped element's URLs resolve: the namespace root, and the fragment's own base href. */
export interface FragmentUrlBase {
  root: string | null;
  baseHref: string;
}

/**
 * Property descriptors for a stamped element's prototype: the element's subresource properties and
 * `setAttribute`/`setAttributeNS` map relative URLs into the fragment's namespace. Empty for an
 * element with no subresource attributes. Reading returns whatever the native getter does.
 */
export function subresourceUrlOverrides(proto: object, localName: string, base: () => FragmentUrlBase): PropertyDescriptorMap {
  const attributes = Object.hasOwn(SUBRESOURCE_ATTRIBUTES, localName) ? SUBRESOURCE_ATTRIBUTES[localName] : undefined;
  if (!attributes) return {};

  const rewrite = (name: string, value: unknown): unknown => {
    if (typeof value !== 'string' || !attributes.includes(name)) return value;
    const { root, baseHref } = base();
    if (root === null) return value;
    return name === 'srcset' ? fragmentSrcset(value, root, baseHref) : fragmentSubresourceUrl(value, root, baseHref);
  };

  const overrides: PropertyDescriptorMap = {};
  for (const name of attributes) {
    const descriptor = findDescriptor(proto, name);
    // SVG's `href` is an SVGAnimatedString with no setter; setAttribute covers it
    if (!descriptor?.set) continue;
    const { get, set } = descriptor;
    overrides[name] = {
      get,
      set(this: Element, value: unknown) {
        set.call(this, rewrite(name, String(value)));
      },
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
    };
  }

  const setAttribute = findDescriptor(proto, 'setAttribute')!.value as Element['setAttribute'];
  const setAttributeNS = findDescriptor(proto, 'setAttributeNS')!.value as Element['setAttributeNS'];
  overrides['setAttribute'] = {
    value: function (this: Element, qualifiedName: string, value: string) {
      return setAttribute.call(this, qualifiedName, rewrite(String(qualifiedName).toLowerCase(), value) as string);
    },
    writable: true,
    configurable: true,
  };
  overrides['setAttributeNS'] = {
    value: function (this: Element, namespace: string | null, qualifiedName: string, value: string) {
      // only un-namespaced attributes are the subresource ones; xlink:href is left as it is
      const mapped = namespace === null || namespace === '' ? rewrite(String(qualifiedName).toLowerCase(), value) : value;
      return setAttributeNS.call(this, namespace, qualifiedName, mapped as string);
    },
    writable: true,
    configurable: true,
  };
  return overrides;
}

function findDescriptor(object: object, name: string): PropertyDescriptor | undefined {
  for (let current: object | null = object; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) return descriptor;
  }
  return undefined;
}
