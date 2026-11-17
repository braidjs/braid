/**
 * Helpers shared inside the package. Not exported from the package entry.
 */

/** Keys that are properties of every object, or change one. Never a name in a document. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** A slot name, an action name, a flag key: a short plain word, and none of the reserved ones. */
export function isSafeName(value: unknown): value is string {
  return (
    typeof value === 'string' && NAME.test(value) && !RESERVED_KEYS.has(value)
  );
}

/**
 * An own-property lookup. Every map here is keyed by names that arrive in documents — component
 * types, action types, slot names — and a document may name one `constructor`. Indexing with `[]`
 * would find `Object.prototype.constructor` and treat it as a catalog entry.
 */
export function own<T>(
  record: Readonly<Record<string, T>> | undefined | null,
  key: string,
): T | undefined {
  return record !== undefined &&
    record !== null &&
    Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The first reserved key found anywhere in a value, or `null`. Bounded in depth: past it the
 * answer is "yes", since a value that deep is not configuration.
 */
export function reservedKeyIn(value: unknown, depth = 0): string | null {
  if (typeof value !== 'object' || value === null) return null;
  if (depth > 64) return '(nested too deeply)';
  if (Array.isArray(value)) {
    for (const element of value) {
      const found = reservedKeyIn(element, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (RESERVED_KEYS.has(key)) return key;
    const found = reservedKeyIn(inner, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * What makes a value something other than JSON, or `null`: a bigint, a function, a symbol, an
 * `undefined`, a number that is not finite, or an object that is not a plain one. Everything here
 * is hashed, compared and serialised as JSON, and none of those survive it — some of them throw.
 *
 * Not recursive: the caller is already walking the value.
 */
export function notJson(value: unknown): string | null {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return null;
    case 'number':
      return Number.isFinite(value) ? null : 'a number that is not finite';
    case 'object': {
      if (value === null || Array.isArray(value)) return null;
      const prototype: unknown = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null
        ? null
        : 'an object that is not plain data';
    }
    default:
      return typeof value === 'undefined' ? 'undefined' : `a ${typeof value}`;
  }
}

/**
 * Whether a value nests more than `limit` levels. It stops looking as soon as the answer is yes,
 * so it is safe on a value far deeper than the stack.
 */
export function deeperThan(value: unknown, limit: number): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (limit <= 0) return true;
  for (const inner of Array.isArray(value) ? value : Object.values(value))
    if (deeperThan(inner, limit - 1)) return true;
  return false;
}

/** Whether a dotted path has a reserved segment: `a.__proto__.b`, `constructor`. */
export function hasReservedSegment(path: string): boolean {
  return path.split(/[.[\]]/).some((segment) => RESERVED_KEYS.has(segment));
}

/**
 * Printable text for a log line: control characters and line separators, which could forge one,
 * are replaced with "?".
 */
export function printable(text: string, max = 200): string {
  let clean = '';
  for (const char of text.length > max ? text.slice(0, max) : text) {
    const code = char.codePointAt(0) as number;
    const control =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029;
    clean += control ? '?' : char;
  }
  return text.length > max ? `${clean}...` : clean;
}
