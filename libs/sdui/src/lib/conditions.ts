import { canonicalJson } from '@braidlabs/skew';
import type { Condition } from './model.js';

/**
 * Evaluating the closed condition language.
 *
 * **Fails closed, all the way through.** A term about something the context does not say — no
 * platform given, a flag that does not exist, a version that is not a version — is neither true
 * nor false: it is unknown. Unknown survives `not`, so "not on iOS" is not suddenly true for a
 * request that never said what it is on. Only a condition that is *known to hold* shows a node.
 */
export interface ConditionContext {
  /** Evaluated flag values, as `evaluateFlags` returns them. */
  readonly flags?: Readonly<Record<string, unknown>>;
  readonly platform?: string;
  readonly appVersion?: string;
  /** The audience segments this principal is in. An empty list is knowledge; `undefined` is not. */
  readonly audiences?: readonly string[];
  readonly locale?: string;
  /** Server time. Schedules are never evaluated against a device's clock. */
  readonly now?: Date | string;
}

type Tri = true | false | null;

const flagTerm = (condition: {
  readonly flag: string;
  readonly is?: unknown;
}): string =>
  canonicalJson(
    'is' in condition ? [condition.flag, condition.is] : [condition.flag],
  );

function evaluate(
  condition: Condition,
  context: ConditionContext,
  assumed?: ReadonlyMap<string, boolean>,
): Tri {
  if (typeof condition !== 'object' || condition === null) return null;
  if ('all' in condition) {
    if (!Array.isArray(condition.all)) return null;
    let unknown = false;
    for (const inner of condition.all) {
      const result = evaluate(inner, context, assumed);
      if (result === false) return false;
      if (result === null) unknown = true;
    }
    return unknown ? null : true;
  }
  if ('any' in condition) {
    if (!Array.isArray(condition.any)) return null;
    let unknown = false;
    for (const inner of condition.any) {
      const result = evaluate(inner, context, assumed);
      if (result === true) return true;
      if (result === null) unknown = true;
    }
    return unknown ? null : false;
  }
  if ('not' in condition) {
    const result = evaluate(condition.not, context, assumed);
    return result === null ? null : !result;
  }
  if ('flag' in condition) {
    const forced = assumed?.get(flagTerm(condition));
    if (forced !== undefined) return forced;
    const flags = context.flags;
    if (!flags || !Object.prototype.hasOwnProperty.call(flags, condition.flag))
      return null;
    const value = flags[condition.flag];
    return 'is' in condition
      ? canonicalJson(value) === canonicalJson(condition.is)
      : Boolean(value);
  }
  if ('platform' in condition) {
    if (
      typeof context.platform !== 'string' ||
      !Array.isArray(condition.platform)
    )
      return null;
    return condition.platform.includes(context.platform);
  }
  if ('audience' in condition) {
    if (!Array.isArray(context.audiences)) return null;
    return context.audiences.includes(condition.audience);
  }
  if ('locale' in condition) {
    if (
      typeof context.locale !== 'string' ||
      context.locale.length === 0 ||
      !Array.isArray(condition.locale)
    )
      return null;
    const locale = context.locale.toLowerCase();
    return condition.locale.some((wanted) => {
      const w = String(wanted).toLowerCase();
      return locale === w || locale.startsWith(`${w}-`);
    });
  }
  if ('appVersion' in condition) {
    const version = parseVersion(context.appVersion);
    const bounds = condition.appVersion;
    if (!version || typeof bounds !== 'object' || bounds === null) return null;
    for (const [key, sign] of [
      ['min', -1],
      ['max', 1],
    ] as const) {
      if (bounds[key] === undefined) continue;
      const bound = parseVersion(bounds[key]);
      if (!bound) return null;
      if (compareParts(version, bound) === sign) return false;
    }
    return true;
  }
  if ('schedule' in condition) {
    const now =
      context.now === undefined ? Number.NaN : new Date(context.now).getTime();
    const window = condition.schedule;
    if (Number.isNaN(now) || typeof window !== 'object' || window === null)
      return null;
    for (const key of ['from', 'until'] as const) {
      if (window[key] === undefined) continue;
      const at =
        typeof window[key] === 'string'
          ? new Date(window[key] as string).getTime()
          : Number.NaN;
      if (Number.isNaN(at)) return null;
      if (key === 'from' ? now < at : now >= at) return false;
    }
    return true;
  }
  return null;
}

/** Whether a condition is known to hold. Unknown is not true. */
export function evaluateCondition(
  condition: Condition,
  context: ConditionContext,
): boolean {
  return evaluate(condition, context) === true;
}

/**
 * For a condition that does not hold: would it, if its flags were set differently and nothing
 * else changed? That is the difference between "hidden by a flag" and "hidden from this person".
 *
 * Tries every setting of the condition's flag terms, so it is exact for the handful of flags a
 * real condition has; past ten distinct terms it answers `false` rather than search.
 */
export function hiddenByFlagsAlone(
  condition: Condition,
  context: ConditionContext,
): boolean {
  const terms = [...new Set(flagTermsIn(condition))];
  if (terms.length === 0 || terms.length > 10) return false;
  for (let mask = 0; mask < 1 << terms.length; mask++) {
    const assumed = new Map(
      terms.map((term, index) => [term, (mask & (1 << index)) !== 0]),
    );
    if (evaluate(condition, context, assumed) === true) return true;
  }
  return false;
}

function flagTermsIn(condition: Condition): string[] {
  if (typeof condition !== 'object' || condition === null) return [];
  if ('flag' in condition) return [flagTerm(condition)];
  if ('all' in condition)
    return Array.isArray(condition.all)
      ? condition.all.flatMap(flagTermsIn)
      : [];
  if ('any' in condition)
    return Array.isArray(condition.any)
      ? condition.any.flatMap(flagTermsIn)
      : [];
  if ('not' in condition) return flagTermsIn(condition.not);
  return [];
}

/** The flag names a condition reads, for checking a release against the flags that exist. */
export function flagsIn(condition: Condition): string[] {
  if (typeof condition !== 'object' || condition === null) return [];
  if ('flag' in condition) return [condition.flag];
  if ('all' in condition)
    return Array.isArray(condition.all) ? condition.all.flatMap(flagsIn) : [];
  if ('any' in condition)
    return Array.isArray(condition.any) ? condition.any.flatMap(flagsIn) : [];
  if ('not' in condition) return flagsIn(condition.not);
  return [];
}

const VERSION = /^\d{1,9}(\.\d{1,9}){0,7}$/;

/** A dotted-number version as its parts, or `null` for anything that is not one. */
export function parseVersion(value: unknown): number[] | null {
  return typeof value === 'string' && VERSION.test(value)
    ? value.split('.').map(Number)
    : null;
}

function compareParts(
  left: readonly number[],
  right: readonly number[],
): -1 | 0 | 1 {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Orders two dotted-number versions: `5.8` < `5.10` < `6`, and `5.8` equals `5.8.0`. Returns
 * `null` when either is not a version — a caller has to decide what an unreadable version means
 * rather than have it quietly count as zero.
 */
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  return left && right ? compareParts(left, right) : null;
}
