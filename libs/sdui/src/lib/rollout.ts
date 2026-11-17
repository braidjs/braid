import {
  type ConditionContext,
  evaluateCondition,
  flagsIn,
} from './conditions.js';
import { hash32 } from './hash.js';
import { isRecord, isSafeName } from './internal.js';
import { type Condition, parseCondition } from './model.js';

/**
 * Staged rollouts and flags — the pure half.
 *
 * Both come down to one question: is this install inside a percentage? The answer has to be the
 * same on every server, on every request, and has to *grow* as the percentage grows — a device
 * that got the candidate at 5% must still have it at 25%, or people watch a screen change and
 * change back.
 *
 * A bucket does that. Each install hashes, with a salt, to a fixed number in 0–9999; a percentage
 * is the set of buckets below a line. Raising the percentage moves the line and never moves a
 * device across it backwards. The salt is per rollout (or per flag) so that the same unlucky 1%
 * of devices are not first in line for everything.
 *
 * **A percentage is not access control.** A device chooses its own install id and the hash is
 * public, so a determined one can pick an id that lands inside any percentage. Gate what must be
 * gated with an audience the server derives from a verified identity.
 */

export const BUCKETS = 10_000;

/** The install's bucket for a salt: an integer in 0–9999, stable forever. */
export function bucketOf(salt: string, install: string): number {
  return hash32(`${salt}\u0000${install}`) % BUCKETS;
}

/** Whether a bucket falls inside a percentage (0–100, fractions allowed down to 0.01). */
export function inPercent(bucket: number, percent: number): boolean {
  if (typeof percent !== 'number' || Number.isNaN(percent)) return false;
  return bucket < Math.round(Math.min(100, Math.max(0, percent)) * 100);
}

/**
 * An install with no id cannot be bucketed, and all of them hashing to one bucket would move
 * every anonymous device in or out together. It is inside a percentage only when that is 100.
 */
function installInPercent(
  salt: string,
  install: string | undefined | null,
  percent: number,
): { inside: boolean; bucket: number | null } {
  if (typeof install !== 'string' || install.length === 0)
    return { inside: percent >= 100, bucket: null };
  const bucket = bucketOf(salt, install);
  return { inside: inPercent(bucket, percent), bucket };
}

/** When a device that is told about a new release starts showing it. */
export type ApplyBoundary = 'next-launch' | 'next-navigation' | 'immediate';

export interface RolloutPlan {
  /** What everyone outside the rollout gets. */
  readonly stable: string;
  /** What is being rolled out. */
  readonly candidate: string;
  /** Percentages, ascending: `[1, 5, 25, 50, 100]`. */
  readonly stages: readonly number[];
  /** Index into `stages` of the stage now in force. */
  readonly stage: number;
  readonly salt: string;
  /** Who is eligible at all. Everyone else stays on stable regardless of bucket. */
  readonly audience?: Condition;
  /** Halted: everyone back on stable, without losing the plan. */
  readonly halted?: boolean;
  readonly apply?: ApplyBoundary;
}

export interface RolloutAssignment {
  readonly release: string;
  readonly arm: 'stable' | 'candidate';
  /** `null` for a request with no install id. */
  readonly bucket: number | null;
}

/**
 * The share of eligible devices on the candidate right now, in percent. A stage index that is not
 * one of the plan's stages is nobody, not everybody.
 */
export function rolloutPercent(plan: RolloutPlan): number {
  if (plan.halted) return 0;
  if (
    !Number.isInteger(plan.stage) ||
    plan.stage < 0 ||
    plan.stage >= plan.stages.length
  )
    return 0;
  const percent = plan.stages[plan.stage];
  return typeof percent === 'number' && Number.isFinite(percent) ? percent : 0;
}

export function assignRollout(
  plan: RolloutPlan,
  install: string | undefined | null,
  context: ConditionContext = {},
): RolloutAssignment {
  const eligible = plan.audience
    ? evaluateCondition(plan.audience, context)
    : true;
  const { inside, bucket } = installInPercent(
    plan.salt,
    install,
    rolloutPercent(plan),
  );
  const candidate = eligible && inside;
  return {
    release: candidate ? plan.candidate : plan.stable,
    arm: candidate ? 'candidate' : 'stable',
    bucket,
  };
}

/** Validates an untrusted value as a rollout plan. Throws `TypeError` naming the first problem. */
export function parseRolloutPlan(raw: unknown): RolloutPlan {
  const fail = (message: string): never => {
    throw new TypeError(`sdui rollout: ${message}`);
  };
  const isText = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 128;
  if (!isRecord(raw)) return fail('plan must be an object');
  for (const key of ['stable', 'candidate', 'salt'] as const) {
    if (!isText(raw[key]))
      fail(`${key} must be a non-empty string of at most 128 characters`);
  }
  const stages = raw['stages'];
  if (!Array.isArray(stages) || stages.length === 0 || stages.length > 32)
    return fail('stages must be an array of 1 to 32 percentages');
  stages.forEach((percent, index) => {
    if (typeof percent !== 'number' || !(percent > 0 && percent <= 100))
      fail(`stages[${index}] must be a percentage above 0 and at most 100`);
    if (index > 0 && !(percent > stages[index - 1]))
      fail('stages must ascend, so that a rollout only ever widens');
  });
  if (
    !Number.isInteger(raw['stage']) ||
    (raw['stage'] as number) < 0 ||
    (raw['stage'] as number) >= stages.length
  )
    fail(`stage must be an index into stages, 0 to ${stages.length - 1}`);
  if (raw['halted'] !== undefined && typeof raw['halted'] !== 'boolean')
    fail('halted must be a boolean');
  if (
    raw['apply'] !== undefined &&
    !['next-launch', 'next-navigation', 'immediate'].includes(
      raw['apply'] as string,
    )
  )
    fail('apply must be next-launch, next-navigation or immediate');
  if (raw['audience'] !== undefined) parseCondition(raw['audience']);
  return raw as unknown as RolloutPlan;
}

// --- flags -------------------------------------------------------------------

export interface FlagRule {
  /** Who this rule is for. Absent means everyone. Flag terms are not allowed here. */
  readonly when?: Condition;
  /** The share of matching installs that get `value`. Defaults to 100. */
  readonly percent?: number;
  readonly value: unknown;
}

export interface FlagDefinition {
  readonly key: string;
  /** What a device gets when no rule matches, when the flag is off, or when it cannot ask. */
  readonly default: unknown;
  /** First match wins. */
  readonly rules?: readonly FlagRule[];
  /** The kill switch: ignore every rule and serve the default. */
  readonly off?: boolean;
  /** Defaults to the key. Change it to reshuffle who is in a percentage. */
  readonly salt?: string;
  readonly owner?: string;
  /** ISO date after which this flag is a lint: a flag nobody removed. */
  readonly expires?: string;
}

export interface FlagEvaluation {
  readonly values: Readonly<Record<string, unknown>>;
  /** `key:ruleIndex` for each flag decided by a rule — what exposure events carry. */
  readonly assignments: readonly string[];
}

/**
 * Evaluates every flag for one install. This runs on the server: a device is sent values and
 * assignment ids, never rules, so an unreleased audience or percentage does not ship in a binary's
 * traffic.
 */
export function evaluateFlags(
  definitions: readonly FlagDefinition[],
  install: string | undefined | null,
  context: ConditionContext = {},
): FlagEvaluation {
  const values = new Map<string, unknown>();
  const assignments: string[] = [];
  // Rules never see other flags, so there is no evaluation order to get wrong and no cycle.
  const ruleContext: ConditionContext = { ...context, flags: {} };
  for (const definition of definitions) {
    values.set(definition.key, definition.default);
    if (definition.off) continue;
    const index = (definition.rules ?? []).findIndex(
      (rule) =>
        (rule.when ? evaluateCondition(rule.when, ruleContext) : true) &&
        installInPercent(
          definition.salt ?? definition.key,
          install,
          rule.percent ?? 100,
        ).inside,
    );
    if (index < 0) continue;
    values.set(
      definition.key,
      (definition.rules as readonly FlagRule[])[index]?.value,
    );
    assignments.push(`${definition.key}:${index}`);
  }
  // Defined from entries, never assigned: a flag keyed `__proto__` must not become the prototype.
  return { values: Object.fromEntries(values), assignments };
}

/** Validates untrusted flag definitions. Throws `TypeError` naming the first problem. */
export function parseFlagDefinitions(raw: unknown): FlagDefinition[] {
  const fail = (message: string): never => {
    throw new TypeError(`sdui flags: ${message}`);
  };
  if (!Array.isArray(raw)) return fail('definitions must be an array');
  const seen = new Set<string>();
  raw.forEach((definition, index) => {
    if (!isRecord(definition))
      return fail(`definition ${index} must be an object`);
    const key = definition['key'];
    if (!isSafeName(key))
      return fail(`definition ${index} needs a key that is a short plain word`);
    if (seen.has(key)) fail(`flag "${key}" is defined twice`);
    seen.add(key);
    if (!('default' in definition))
      fail(
        `flag "${key}" needs a default — what a device gets when it cannot ask`,
      );
    if (
      definition['off'] !== undefined &&
      typeof definition['off'] !== 'boolean'
    )
      fail(`flag "${key}": off must be a boolean`);
    if (
      definition['salt'] !== undefined &&
      (typeof definition['salt'] !== 'string' ||
        definition['salt'].length === 0)
    )
      fail(`flag "${key}": salt must be a non-empty string`);
    const rules = definition['rules'];
    if (rules === undefined) return;
    if (!Array.isArray(rules) || rules.length > 64)
      return fail(`flag "${key}": rules must be an array of at most 64`);
    rules.forEach((rule, at) => {
      if (!isRecord(rule) || !('value' in rule))
        return fail(`flag "${key}" rule ${at} needs a value`);
      const percent = rule['percent'];
      if (
        percent !== undefined &&
        (typeof percent !== 'number' || !(percent >= 0 && percent <= 100))
      )
        fail(`flag "${key}" rule ${at}: percent must be between 0 and 100`);
      if (rule['when'] !== undefined) {
        if (flagsIn(parseCondition(rule['when'])).length > 0)
          fail(`flag "${key}" rule ${at}: a rule cannot read another flag`);
      }
    });
  });
  return raw as FlagDefinition[];
}
