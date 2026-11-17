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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}
