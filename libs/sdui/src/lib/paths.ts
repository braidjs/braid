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
