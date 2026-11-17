import { type ConditionContext, evaluateCondition } from './conditions.js';
import { hash32 } from './hash.js';
import type { Condition } from './model.js';

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
 */

export const BUCKETS = 10_000;

/** The install's bucket for a salt: an integer in 0–9999, stable forever. */
export function bucketOf(salt: string, install: string): number {
  return hash32(`${salt}\u0000${install}`) % BUCKETS;
}

/** Whether a bucket falls inside a percentage (0–100, fractions allowed down to 0.01). */
export function inPercent(bucket: number, percent: number): boolean {
  return bucket < Math.round(Math.min(100, Math.max(0, percent)) * 100);
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
  readonly bucket: number;
}

/** The share of eligible devices on the candidate right now, in percent. */
export function rolloutPercent(plan: RolloutPlan): number {
  if (plan.halted) return 0;
  return (
    plan.stages[Math.min(Math.max(0, plan.stage), plan.stages.length - 1)] ?? 0
  );
}

export function assignRollout(
  plan: RolloutPlan,
  install: string,
  context: ConditionContext = {},
): RolloutAssignment {
  const bucket = bucketOf(plan.salt, install);
  const eligible = plan.audience
    ? evaluateCondition(plan.audience, context)
    : true;
  const candidate = eligible && inPercent(bucket, rolloutPercent(plan));
  return {
    release: candidate ? plan.candidate : plan.stable,
    arm: candidate ? 'candidate' : 'stable',
    bucket,
  };
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
  install: string,
  context: ConditionContext = {},
): FlagEvaluation {
  const values: Record<string, unknown> = {};
  const assignments: string[] = [];
  // Rules never see other flags, so there is no evaluation order to get wrong and no cycle.
  const ruleContext: ConditionContext = { ...context, flags: {} };
  for (const definition of definitions) {
    values[definition.key] = definition.default;
    if (definition.off) continue;
    const bucket = bucketOf(definition.salt ?? definition.key, install);
    const index = (definition.rules ?? []).findIndex(
      (rule) =>
        (rule.when ? evaluateCondition(rule.when, ruleContext) : true) &&
        inPercent(bucket, rule.percent ?? 100),
    );
    if (index < 0) continue;
    values[definition.key] = (definition.rules as readonly FlagRule[])[
      index
    ]?.value;
    assignments.push(`${definition.key}:${index}`);
  }
  return { values, assignments };
}
