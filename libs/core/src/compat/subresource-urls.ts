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
export const SUBRESOURCE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
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
};

const NAMESPACE = /^(.*?\/__braid\/frag\/[^/]+)(\/.*)?$/;

/**
 * One URL mapped into the fragment's namespace, given the realm document's base URL (which points
 * into that namespace). Absolute URLs, protocol-relative ones and pure fragments are returned as
 * they are, and so is anything when the base is not a fragment namespace.
 */
export function fragmentSubresourceUrl(value: string, realmBaseUrl: string): string {
  const url = value.trim();
  if (!url || url.startsWith('#') || url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return value;

  let basePath: string;
  try {
    basePath = new URL(realmBaseUrl).pathname;
  } catch {
    return value;
  }
  const match = NAMESPACE.exec(basePath);
  if (!match) return value;
  const [, root, fragmentBase = '/'] = match;

  // resolve as the fragment's own document would, then re-root — the gateway's rule exactly
  const resolved = new URL(url, `http://braid.invalid${fragmentBase}`);
  return `${root}${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/** Each candidate of a `srcset`, mapped, with its descriptor kept. */
export function fragmentSrcset(value: string, realmBaseUrl: string): string {
  return value
    .split(',')
    .map((candidate) => {
      const match = /^(\s*)(\S+)(\s*.*)$/.exec(candidate);
      if (!match) return candidate;
      const [, leading, url, descriptor] = match;
      return `${leading}${fragmentSubresourceUrl(url, realmBaseUrl)}${descriptor}`;
    })
    .join(',');
}

/**
 * Property descriptors for a stamped element's prototype: the element's subresource properties and
 * `setAttribute`/`setAttributeNS` map relative URLs into the fragment's namespace. Empty for an
 * element with no subresource attributes. Reading returns whatever the native getter does.
 */
export function subresourceUrlOverrides(proto: object, localName: string, realmBaseUrl: () => string): PropertyDescriptorMap {
  const attributes = SUBRESOURCE_ATTRIBUTES[localName];
  if (!attributes) return {};

  const rewrite = (name: string, value: unknown): unknown => {
    if (typeof value !== 'string' || !attributes.includes(name)) return value;
    return name === 'srcset' ? fragmentSrcset(value, realmBaseUrl()) : fragmentSubresourceUrl(value, realmBaseUrl());
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
