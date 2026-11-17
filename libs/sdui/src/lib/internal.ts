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
