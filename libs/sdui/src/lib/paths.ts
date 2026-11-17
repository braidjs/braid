import { canonicalJson } from '@braidlabs/skew';

/**
 * Paths into a payload.
 *
 * Inside the package a path is a list of segments — a key or an array index — never a string to
 * be parsed back: a prop may be keyed `x[3]` or `a.b`, and a string could not tell that from an
 * index or a nesting. Strings are for reports only.
 */
export type PathSegment = string | number;
export type Path = readonly PathSegment[];

/** A path as it is shown: `items[2].badge`. */
export function formatPath(path: Path): string {
  let out = '';
  for (const segment of path) {
    out +=
      typeof segment === 'number'
        ? `[${segment}]`
        : out === ''
          ? segment
          : `.${segment}`;
  }
  return out;
}

/** The kind of place a path is, whichever list element it is in: `items[].badge`. */
export function shapeOf(path: Path): string {
  return formatPath(path).replace(/\[\d+\]/g, '[]');
}

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
 * Where `original` held something that `back` does not give back — `back` being the same value
 * after a trip down to an older version and up again.
 *
 * Directed on purpose. A field the author never wrote, which the trip up filled with a default,
 * is not something the trip down lost; only a value that was there and did not return is. A
 * `null` and an absent field are the same nothing.
 */
export function lostSegments(
  original: unknown,
  back: unknown,
  prefix: Path = [],
): Path[] {
  if (original === undefined || original === null) return [];
  if (isPlainRecord(original)) {
    const keys = Object.keys(original).sort();
    if (!isPlainRecord(back))
      return keys.some(
        (key) => lostSegments(original[key], undefined).length > 0,
      )
        ? [prefix]
        : [];
    return keys.flatMap((key) =>
      lostSegments(original[key], ownValue(back, key), [...prefix, key]),
    );
  }
  if (Array.isArray(original)) {
    if (!Array.isArray(back) || back.length !== original.length)
      return [prefix];
    return original.flatMap((element, position) =>
      lostSegments(element, back[position], [...prefix, position]),
    );
  }
  return canonicalJson(original) === canonicalJson(back ?? null)
    ? []
    : [prefix];
}

/** {@link lostSegments}, as the strings a report shows. */
export function lostPaths(original: unknown, back: unknown): string[] {
  return lostSegments(original, back).map(formatPath);
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

function stepInto(scope: unknown, segment: PathSegment): unknown {
  if (typeof segment === 'number')
    return Array.isArray(scope) ? scope[segment] : undefined;
  return isPlainRecord(scope) ? ownValue(scope, segment) : undefined;
}

/**
 * A copy of `target` in which the value at each of `paths` is whatever `source` has there — or
 * nothing, if `source` has nothing there. Used to ask what a set of losses does to a payload,
 * leaving everything else exactly as it was.
 *
 * It never grows an array: an index past the end of one is not a place in `target`, and is left
 * alone.
 */
export function withValuesFrom(
  target: unknown,
  source: unknown,
  paths: readonly Path[],
): unknown {
  if (paths.some((path) => path.length === 0)) return structuredClone(source);
  const copy = structuredClone(target);
  for (const path of paths) {
    let into: unknown = copy;
    let from: unknown = source;
    for (let i = 0; i < path.length - 1 && into !== undefined; i++) {
      into = stepInto(into, path[i] as PathSegment);
      from = stepInto(from, path[i] as PathSegment);
    }
    const last = path[path.length - 1] as PathSegment;
    const value = stepInto(from, last);
    if (typeof last === 'number') {
      if (Array.isArray(into) && last < into.length)
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
