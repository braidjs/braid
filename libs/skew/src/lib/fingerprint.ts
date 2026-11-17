/**
 * Content fingerprints for schemas and their steps.
 *
 * Two independently built bundles can declare a chain under the same contract
 * name. When their declarations *agree*, that duplication is harmless; when
 * they disagree — same name, same version numbers, different meaning — the
 * result is the silent kind of corruption nothing else in the system can see.
 * A fingerprint makes "do these two declarations agree?" a cheap, answerable
 * question.
 *
 * What goes into a step's fingerprint is deliberate:
 *
 * - For an ops step, the canonical JSON of the ops — the ops *are* the
 *   migration, so structural equality is real equality.
 * - For a code step, the target version and the (required) description — and
 *   **not** `Function.prototype.toString()`. Two builds minify the same source
 *   differently, so function text equality would report false conflicts
 *   between builds that genuinely agree. The description is the human-owned
 *   identity of a code step; that is one of the reasons it is required.
 */

import type { MigrationStep } from './versioned.js';

/** FNV-1a, 32-bit, hex output. Small, stable, dependency-free. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * JSON with object keys sorted at every level, so logically identical
 * documents always serialize identically.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    // Defined, not assigned: `sorted['__proto__'] = x` would set the copy's prototype and drop the
    // key, so two documents that differ only under an own `__proto__` key would serialize — and
    // fingerprint — identically.
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      Object.defineProperty(sorted, key, {
        value: sortKeys(source[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return sorted;
  }
  return value;
}

/** Fingerprint of a single migration step. */
export function stepFingerprint(step: MigrationStep): string {
  const body = step.ops ? canonicalJson(step.ops) : 'code';
  return fnv1a(`${step.to}:${step.description}:${body}`);
}

/** Fingerprint of a whole chain: name, current version, and every step. */
export function chainFingerprint(
  name: string,
  version: number,
  steps: readonly (MigrationStep | undefined)[],
): string {
  // A hole (a known-of but not-runnable step) fingerprints as such — two
  // builds missing the same implementation still agree about the chain.
  const parts = steps.map((s) => (s ? stepFingerprint(s) : 'hole')).join('.');
  return fnv1a(`${name}@${version}:${parts}`);
}
