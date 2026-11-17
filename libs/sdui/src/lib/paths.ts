import { canonicalJson } from '@braidlabs/skew';

/**
 * Dot-paths at which two values differ. Arrays of the same length are compared element by
 * element (`items[2].badge`); arrays of different lengths differ as a whole.
 */
export function changedPaths(a: unknown, b: unknown, prefix = ''): string[] {
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((key) =>
      changedPaths(
        ownValue(a, key),
        ownValue(b, key),
        prefix ? `${prefix}.${key}` : key,
      ),
    );
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((element, position) =>
      changedPaths(element, b[position], `${prefix}[${position}]`),
    );
  }
  return canonicalJson(a ?? null) === canonicalJson(b ?? null) ? [] : [prefix];
}

/**
 * What `original` held that `back` does not give back — `back` being the same value after a trip
 * down to an older version and up again.
 *
 * Directed on purpose. A field the author never wrote, which the trip up filled with a default,
 * is not something the trip down lost; only a value that was there and did not return is. A
 * `null` and an absent field are the same nothing.
 */
export function lostPaths(
  original: unknown,
  back: unknown,
  prefix = '',
): string[] {
  if (original === undefined || original === null) return [];
  if (isPlainRecord(original)) {
    const keys = Object.keys(original).sort();
    if (!isPlainRecord(back))
      return keys.some(
        (key) => lostPaths(original[key], undefined, key).length > 0,
      )
        ? [prefix]
        : [];
    return keys.flatMap((key) =>
      lostPaths(
        original[key],
        ownValue(back, key),
        prefix ? `${prefix}.${key}` : key,
      ),
    );
  }
  if (Array.isArray(original)) {
    if (!Array.isArray(back) || back.length !== original.length)
      return [prefix];
    return original.flatMap((element, position) =>
      lostPaths(element, back[position], `${prefix}[${position}]`),
    );
  }
  return canonicalJson(original) === canonicalJson(back ?? null)
    ? []
    : [prefix];
}

/**
 * Whether one path is the other or lies under it, ignoring which element of a list is meant:
 * `price.amount` and `price` are within each other, and `items[2].badge` is within `items`.
 */
export function pathWithin(path: string, prefix: string): boolean {
  const normalize = (p: string): string => p.replace(/\[\d*\]/g, '');
  const a = normalize(path);
  const b = normalize(prefix);
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

type Segment = string | number;

/** Splits a path as `lostPaths` writes them: `items[1].badge` is `items`, 1, `badge`. */
function segmentsOf(path: string): Segment[] {
  const segments: Segment[] = [];
  for (const part of path.split('.')) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!match) return [part];
    if (match[1] !== '') segments.push(match[1] as string);
    for (const index of (match[2] as string).matchAll(/\[(\d+)\]/g))
      segments.push(Number(index[1]));
  }
  return segments;
}

function stepInto(scope: unknown, segment: Segment): unknown {
  if (typeof segment === 'number')
    return Array.isArray(scope) ? scope[segment] : undefined;
  return isPlainRecord(scope) ? ownValue(scope, segment) : undefined;
}

/**
 * A copy of `target` in which the value at `path` is whatever `source` has there — or nothing, if
 * `source` has nothing there. Used to ask what one loss, on its own, does to a payload.
 */
export function withValueFrom(
  target: unknown,
  source: unknown,
  path: string,
): unknown {
  const segments = segmentsOf(path);
  if (path === '' || segments.length === 0) return structuredClone(source);
  const copy = structuredClone(target);
  let into: unknown = copy;
  let from: unknown = source;
  for (let i = 0; i < segments.length - 1; i++) {
    into = stepInto(into, segments[i] as Segment);
    from = stepInto(from, segments[i] as Segment);
    if (typeof into !== 'object' || into === null) return copy;
  }
  const last = segments[segments.length - 1] as Segment;
  const value = stepInto(from, last);
  if (typeof last === 'number') {
    if (Array.isArray(into))
      into[last] = value === undefined ? null : structuredClone(value);
  } else if (isPlainRecord(into)) {
    if (value === undefined) delete into[last];
    else
      Object.defineProperty(into, last, {
        value: structuredClone(value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return copy;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}
