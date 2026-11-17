import { canonicalJson } from '@braidlabs/skew';
import type { Condition } from './model.js';

/**
 * Evaluating the closed condition language.
 *
 * Fails closed: a condition about something the context does not say (no platform given, an
 * audience list that is absent) is false. Showing a gated node because a fact was missing is the
 * wrong way to be wrong.
 */
export interface ConditionContext {
  /** Evaluated flag values, as `evaluateFlags` returns them. */
  readonly flags?: Readonly<Record<string, unknown>>;
  readonly platform?: string;
  readonly appVersion?: string;
  /** The audience segments this principal is in. */
  readonly audiences?: readonly string[];
  readonly locale?: string;
  /** Server time. Schedules are never evaluated against a device's clock. */
  readonly now?: Date | string;
}

export interface EvaluateOptions {
  /** Treat every flag term as satisfied — to ask "is it only a flag keeping this hidden?". */
  readonly assumeFlags?: boolean;
}

export function evaluateCondition(
  condition: Condition,
  context: ConditionContext,
  options: EvaluateOptions = {},
): boolean {
  if ('all' in condition)
    return condition.all.every((inner) =>
      evaluateCondition(inner, context, options),
    );
  if ('any' in condition)
    return condition.any.some((inner) =>
      evaluateCondition(inner, context, options),
    );
  if ('not' in condition) {
    // Under `assumeFlags` a negated flag term is also taken as satisfied, so the question stays
    // "would this show if every flag went its way".
    if (options.assumeFlags && mentionsOnlyFlags(condition.not)) return true;
    return !evaluateCondition(condition.not, context, options);
  }
  if ('flag' in condition) {
    if (options.assumeFlags) return true;
    const flags = context.flags ?? {};
    if (!Object.prototype.hasOwnProperty.call(flags, condition.flag))
      return false;
    const value = flags[condition.flag];
    return 'is' in condition
      ? canonicalJson(value) === canonicalJson(condition.is)
      : Boolean(value);
  }
  if ('platform' in condition)
    return (
      context.platform !== undefined &&
      condition.platform.includes(context.platform)
    );
  if ('audience' in condition)
    return context.audiences?.includes(condition.audience) ?? false;
  if ('locale' in condition) {
    const locale = context.locale?.toLowerCase();
    if (!locale) return false;
    return condition.locale.some((wanted) => {
      const w = wanted.toLowerCase();
      return locale === w || locale.startsWith(`${w}-`);
    });
  }
  if ('appVersion' in condition) {
    if (context.appVersion === undefined) return false;
    const { min, max } = condition.appVersion;
    if (min !== undefined && compareVersions(context.appVersion, min) < 0)
      return false;
    if (max !== undefined && compareVersions(context.appVersion, max) > 0)
      return false;
    return true;
  }
  if ('schedule' in condition) {
    if (context.now === undefined) return false;
    const now = new Date(context.now).getTime();
    if (Number.isNaN(now)) return false;
    const { from, until } = condition.schedule;
    if (from !== undefined && !(now >= new Date(from).getTime())) return false;
    if (until !== undefined && !(now < new Date(until).getTime())) return false;
    return true;
  }
  return false;
}

function mentionsOnlyFlags(condition: Condition): boolean {
  if ('flag' in condition) return true;
  if ('all' in condition) return condition.all.every(mentionsOnlyFlags);
  if ('any' in condition) return condition.any.every(mentionsOnlyFlags);
  if ('not' in condition) return mentionsOnlyFlags(condition.not);
  return false;
}

/** The flag names a condition reads, for checking a release against the flags that exist. */
export function flagsIn(condition: Condition): string[] {
  if ('flag' in condition) return [condition.flag];
  if ('all' in condition) return condition.all.flatMap(flagsIn);
  if ('any' in condition) return condition.any.flatMap(flagsIn);
  if ('not' in condition) return flagsIn(condition.not);
  return [];
}

/**
 * Orders two dotted-number versions: `5.8` < `5.10` < `6`. Missing parts count as zero, so `5.8`
 * equals `5.8.0`. Anything that is not a number counts as zero rather than throwing — a malformed
 * version from a device must not take down a handshake.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}
