/**
 * W3C `baggage` for fragment requests, safely.
 *
 * Baggage is arbitrary key/value context that rides alongside a trace — a tenant, an experiment,
 * a feature flag — and that is the problem with a browser's: a header any page script or extension
 * can set, flowing into every internal service behind every fragment. `new Request(url, request)`
 * used to copy it verbatim. Now a fragment request carries baggage only as the deployment allows:
 *
 * - inbound members are dropped unless their key is allowlisted, and, when the allowlist gives a
 *   pattern, unless their (decoded) value matches it; member properties are dropped;
 * - members the gateway sets itself win over a client's with the same key;
 * - anything over the W3C limits (8192 bytes, 180 members) is dropped whole, as is a header that
 *   cannot be parsed;
 * - and only fragments inside the deployment's trust boundary get any, by the same rule as
 *   `forwardCredentials` — decided by the caller.
 */

export interface BaggageOptions {
  /**
   * Inbound members a fragment may receive: keys, or keys mapped to a pattern their decoded value
   * must match in full. Absent: none.
   */
  forward?: readonly string[] | Readonly<Record<string, RegExp>>;
  /** Members the gateway adds for this request, overriding a client's with the same key. */
  set?: (request: Request) => Record<string, string>;
}

const MAX_BYTES = 8192;
const MAX_MEMBERS = 180;
/** RFC 7230 token, which is what a baggage key is. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function allowedValue(forward: BaggageOptions['forward'], key: string, rawValue: string): boolean {
  if (!forward) return false;
  if (Array.isArray(forward)) return forward.includes(key);
  const patterns = forward as Readonly<Record<string, RegExp>>;
  if (!Object.hasOwn(patterns, key)) return false;
  let value: string;
  try {
    value = decodeURIComponent(rawValue);
  } catch {
    return false;
  }
  const pattern = patterns[key];
  const match = pattern.exec(value);
  return match !== null && match.index === 0 && match[0].length === value.length;
}

/**
 * The `baggage` header a fragment request carries, or `null` for none. The caller decides whether
 * the fragment is inside the trust boundary at all; call this only for one that is.
 */
export function fragmentBaggage(request: Request, options: BaggageOptions | undefined): string | null {
  const members = new Map<string, string>();

  const inbound = request.headers.get('baggage');
  if (inbound && options?.forward && new TextEncoder().encode(inbound).length <= MAX_BYTES) {
    for (const part of inbound.split(',')) {
      const member = part.trim();
      if (!member) continue;
      // properties (`;prop=…`) are dropped: nothing downstream asked for them
      const [pair] = member.split(';');
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const key = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!TOKEN.test(key) || !allowedValue(options.forward, key, value)) continue;
      members.set(key, value);
    }
  }

  for (const [key, value] of Object.entries(options?.set?.(request) ?? {})) {
    if (TOKEN.test(key)) members.set(key, encodeURIComponent(value));
  }

  if (members.size === 0 || members.size > MAX_MEMBERS) return null;
  const header = [...members].map(([key, value]) => `${key}=${value}`).join(',');
  return new TextEncoder().encode(header).length <= MAX_BYTES ? header : null;
}
