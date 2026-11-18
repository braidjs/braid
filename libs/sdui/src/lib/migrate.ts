import {
  type CompiledLens,
  type MigrationContext,
  compileLens,
  defaultMigrationContext,
} from '@braidlabs/skew';
import type {
  ContractCodeStep,
  SkewContractDocument,
  SkewContractStep,
} from '@braidlabs/contract';
import { measure } from './internal.js';
import { type Path, formatPath, lostSegments } from './paths.js';

/**
 * How deep a migrated payload may nest. A screen's props stop at 32; steps may wrap them further,
 * but a result past this is no payload, and the functions that compare payloads recurse.
 */
export const MIGRATED_DEPTH_LIMIT = 64;

/**
 * How many values a migrated payload may hold, written out: twice what a whole screen may. Steps
 * that copy a value into itself double it each time, and sixty of them are a few hundred bytes of
 * catalog; nothing downstream should be handed the result.
 */
export const MIGRATED_VALUE_LIMIT = 400_000;

/** How many characters a migrated payload's strings and keys may come to: twice a screen's. */
export const MIGRATED_CHARACTER_LIMIT = 8_000_000;

/**
 * How many characters the paths to all of a migrated payload's values may come to: twice a
 * screen's. Steps that nest a long list under key after key leave its size alone and multiply
 * the length of every path into it, and a report names what was lost by path.
 */
export const MIGRATED_PATH_LIMIT = 32_000_000;

/**
 * What the migrations of one projection, or one diff, may produce between them.
 *
 * The limits above are per payload, and a screen has thousands. A catalog that makes each of them
 * a hundred times larger stays inside every one of those limits and still asks for more memory
 * than there is. So each result is counted against an allowance shared by the whole call; once it
 * is spent, the migrations that remain fail like a step that failed, and their nodes go down the
 * ladder.
 *
 * Forty times a screen at its limits in values, and sixteen times in characters and in paths. A projection
 * migrates each node a handful of times — down, back up to measure the loss, and up to the newest
 * version twice to place it — so a screen at its limits, under a catalog that does not grow its
 * payloads, uses a fraction of this. The lifts that trace losses one at a time are not counted
 * here: `TRACE_BUDGET` rations those.
 */
export const MIGRATION_ALLOWANCE = Object.freeze({
  values: 8_000_000,
  characters: 64_000_000,
  paths: 256_000_000,
});

/** A {@link MIGRATION_ALLOWANCE} being spent. Mutable: every migration given it draws on it. */
export interface MigrationAllowance {
  values: number;
  characters: number;
  /** Optional, so that an allowance may ration size alone. */
  paths?: number;
}

/**
 * Moves one payload between two versions of one contract.
 *
 * This is the same machinery `versionedFromContract` runs — `compileLens` over the document's ops —
 * used directly instead of through the shared registry. A server projects thousands of nodes
 * across many contracts for many clients; doing that through process-wide registry state would
 * make one projection's outcome depend on which others ran first. Here the document is the only
 * input.
 */
export type CodeSteps = Readonly<Record<string, ContractCodeStep<any, any>>>;

export interface MigrateOptions {
  /** Implementations for the document's named `code` steps. Without one, that step is a gap. */
  readonly codeSteps?: CodeSteps;
  /** The clock `$now` reads. Pin it and a migration is a pure function of its inputs. */
  readonly context?: MigrationContext;
  /**
   * What this migration and the others sharing the object may still produce. Drawn down by each
   * result; a migration that finds it spent fails. Without one there is only the limit on each
   * payload.
   */
  readonly allowance?: MigrationAllowance;
}

export type MigrateResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      /**
       * What the payload held that does not come back when it is taken down and straight back
       * up — paths in the shape it had at `from`. A field that was absent and is filled by a
       * default on the way back is not a loss. Always empty when migrating up: what a newer
       * version of a component no longer has is the catalog's decision, not a loss.
       */
      readonly lossyPaths: readonly string[];
      /** For a downgrade: the payload after the trip down and back up, at `from`. */
      readonly roundTrip?: unknown;
      /** `lossyPaths` as key-and-index segments, for callers that need to address the values. */
      readonly lossySegments?: readonly Path[];
      /**
       * Paths the steps fill with guesses rather than authored data, each named as the step that
       * filled it saw it.
       */
      readonly derivedPaths: readonly string[];
    }
  | {
      readonly ok: false;
      /**
       * - `gap` — a step that cannot be run in this direction: not invertible, or a `code` step
       *   with no implementation here.
       * - `threw` — a step failed on this data, could not be compiled, or the loss could not be
       *   measured.
       * - `range` — a version outside what the document covers.
       */
      readonly reason: 'gap' | 'threw' | 'range';
      readonly step?: { readonly from: number; readonly to: number };
      readonly message: string;
    };

type Walk =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly derived: readonly string[];
    }
  | Extract<MigrateResult, { ok: false }>;

function ownStep(
  steps: CodeSteps | undefined,
  name: string,
): ContractCodeStep | undefined {
  return steps && Object.prototype.hasOwnProperty.call(steps, name)
    ? steps[name]
    : undefined;
}

const lenses = new WeakMap<SkewContractStep, CompiledLens>();

function lensOf(step: SkewContractStep): CompiledLens | null {
  if (!step.ops) return null;
  let lens = lenses.get(step);
  if (!lens) {
    lens = compileLens(step.ops);
    lenses.set(step, lens);
  }
  return lens;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Runs the steps between two versions, in order. No loss analysis. */
function walk(
  doc: SkewContractDocument,
  value: unknown,
  from: number,
  to: number,
  options: MigrateOptions,
  ctx: MigrationContext,
): Walk {
  const allowance = options.allowance;
  if (
    allowance &&
    (allowance.values <= 0 ||
      allowance.characters <= 0 ||
      (allowance.paths !== undefined && allowance.paths <= 0))
  )
    return {
      ok: false,
      reason: 'threw',
      message: `"${doc.name}" v${from} → v${to} was not run: the migrations of this call have produced all they may`,
    };
  const derived = new Set<string>();
  let current = value;
  const up = to > from;

  for (let v = up ? from + 1 : from; up ? v <= to : v > to; up ? v++ : v--) {
    const step = doc.steps[v - 2] as SkewContractStep;
    const span = up ? { from: v - 1, to: v } : { from: v, to: v - 1 };
    const label = `"${doc.name}" v${span.from} → v${span.to}`;
    try {
      // Compiling is inside the try: a catalog that was never run through `parseCatalog` may
      // carry ops the lens compiler refuses, and that must cost one node, not the whole screen.
      const lens = lensOf(step);
      const code = step.code
        ? ownStep(options.codeSteps, step.code)
        : undefined;
      if (up) {
        if (!lens && !code)
          return {
            ok: false,
            reason: 'gap',
            step: span,
            message: `${label} is the code step "${step.code}", which has no implementation here`,
          };
        current = lens
          ? lens.up(current, ctx)
          : (code as ContractCodeStep).up(current, ctx);
        for (const path of lens ? lens.derivedUp : (code?.derives ?? []))
          derived.add(path);
      } else {
        const down = lens ? lens.down : code?.down;
        if (!down) {
          const why = lens
            ? 'cannot be inverted'
            : code
              ? `is the code step "${step.code}", which declares no way down`
              : `is the code step "${step.code}", which has no implementation here`;
          return {
            ok: false,
            reason: 'gap',
            step: span,
            message: `${label} ${why}`,
          };
        }
        current = down(current as never, ctx);
        for (const path of lens ? lens.derivedDown : (code?.downDerives ?? []))
          derived.add(path);
      }
    } catch (cause) {
      return {
        ok: false,
        reason: 'threw',
        step: span,
        message: `${label} failed: ${messageOf(cause)}`,
      };
    }
  }
  const size = measure(current, {
    depth: MIGRATED_DEPTH_LIMIT,
    values: MIGRATED_VALUE_LIMIT,
    characters: MIGRATED_CHARACTER_LIMIT,
    paths: MIGRATED_PATH_LIMIT,
  });
  if (typeof size === 'string')
    return {
      ok: false,
      reason: 'threw',
      message: `"${doc.name}" v${from} → v${to} gives a value ${
        size === 'depth'
          ? `nested more than ${MIGRATED_DEPTH_LIMIT} levels deep`
          : size === 'values'
            ? `of more than ${MIGRATED_VALUE_LIMIT} values`
            : size === 'characters'
              ? `of more than ${MIGRATED_CHARACTER_LIMIT} characters`
              : `whose paths come to more than ${MIGRATED_PATH_LIMIT} characters`
      }`,
    };
  if (allowance) {
    allowance.values -= size.values;
    allowance.characters -= size.characters;
    if (allowance.paths !== undefined) allowance.paths -= size.paths;
  }
  return { ok: true, value: current, derived: [...derived] };
}

export function migrate(
  doc: SkewContractDocument,
  value: unknown,
  from: number,
  to: number,
  options: MigrateOptions = {},
): MigrateResult {
  const inRange = (v: number): boolean =>
    Number.isInteger(v) && v >= 1 && v <= doc.current;
  if (!inRange(from) || !inRange(to)) {
    return {
      ok: false,
      reason: 'range',
      message: `"${doc.name}" covers v1 through v${doc.current}; asked for v${from} → v${to}`,
    };
  }
  // One instant for the whole migration, there and back, so `$now` cannot make it disagree with
  // itself.
  const instant = (options.context ?? defaultMigrationContext).now();
  const ctx: MigrationContext = {
    ...(options.context ?? {}),
    now: () => instant,
  };

  const forward = walk(doc, value, from, to, options, ctx);
  if (!forward.ok) return forward;
  if (to >= from)
    return {
      ok: true,
      value: forward.value,
      lossyPaths: [],
      derivedPaths: forward.derived,
    };

  // What a downgrade loses is measured, not read off the ops: take the result straight back up
  // and see what did not come back. A step's own list of "paths I discard" is in that step's
  // coordinates, so a field a later step renamed would be looked for under the wrong name — and
  // it lists a default-valued field as lost when nothing was.
  const back = walk(doc, forward.value, to, from, options, ctx);
  if (!back.ok) {
    return {
      ok: false,
      reason: 'threw',
      ...(back.step ? { step: back.step } : {}),
      message: `cannot tell what "${doc.name}" v${from} → v${to} loses: ${back.message}`,
    };
  }
  const lost = lostSegments(value, back.value);
  return {
    ok: true,
    value: forward.value,
    lossyPaths: lost.map(formatPath),
    lossySegments: lost,
    roundTrip: back.value,
    derivedPaths: forward.derived,
  };
}
