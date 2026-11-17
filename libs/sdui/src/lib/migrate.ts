import {
  type CompiledLens,
  type MigrationContext,
  canonicalJson,
  compileLens,
  defaultMigrationContext,
} from '@braidlabs/skew';
import type {
  ContractCodeStep,
  SkewContractDocument,
  SkewContractStep,
} from '@braidlabs/contract';

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
  readonly context?: MigrationContext;
}

export type MigrateResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      /** Paths that held a value and were discarded on the way down. Empty when migrating up. */
      readonly lossyPaths: readonly string[];
      /** Paths whose values are the migration's guesses rather than authored data. */
      readonly derivedPaths: readonly string[];
    }
  | {
      readonly ok: false;
      /**
       * - `gap` — a step that cannot be run in this direction: not invertible, or a `code` step
       *   with no implementation here.
       * - `threw` — a step ran and failed on this data.
       * - `range` — a version outside what the document covers.
       */
      readonly reason: 'gap' | 'threw' | 'range';
      readonly step?: { readonly from: number; readonly to: number };
      readonly message: string;
    };

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
  const ctx = options.context ?? defaultMigrationContext;
  const lossy = new Set<string>();
  const derived = new Set<string>();
  let current = value;

  const stepTo = (target: number): SkewContractStep =>
    doc.steps[target - 2] as SkewContractStep;

  if (to > from) {
    for (let v = from + 1; v <= to; v++) {
      const step = stepTo(v);
      const span = { from: v - 1, to: v };
      const lens = lensOf(step);
      const code = step.code
        ? ownStep(options.codeSteps, step.code)
        : undefined;
      if (!lens && !code) {
        return {
          ok: false,
          reason: 'gap',
          step: span,
          message: `"${doc.name}" v${span.from} → v${span.to} is the code step "${step.code}", which has no implementation here`,
        };
      }
      try {
        current = lens
          ? lens.up(current, ctx)
          : (code as ContractCodeStep).up(current, ctx);
      } catch (cause) {
        return {
          ok: false,
          reason: 'threw',
          step: span,
          message: `"${doc.name}" v${span.from} → v${span.to} failed: ${messageOf(cause)}`,
        };
      }
      for (const path of lens ? lens.derivedUp : (code?.derives ?? []))
        derived.add(path);
    }
  } else {
    for (let v = from; v > to; v--) {
      const step = stepTo(v);
      const span = { from: v, to: v - 1 };
      const lens = lensOf(step);
      const code = step.code
        ? ownStep(options.codeSteps, step.code)
        : undefined;
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
          message: `"${doc.name}" v${span.from} → v${span.to} ${why}`,
        };
      }
      // A down-step's lossy paths are static — "this step discards `badge`" — whether or not this
      // payload had a badge worth keeping. What was really lost is what going down and straight
      // back up does not give back: an authored badge is, a badge still at its default is not.
      const candidates = (lens ? lens.lossyDown : (code?.lossy ?? [])).filter(
        (path) => hasPath(current, path),
      );
      const before = current;
      try {
        current = down(current as never, ctx);
      } catch (cause) {
        return {
          ok: false,
          reason: 'threw',
          step: span,
          message: `"${doc.name}" v${span.from} → v${span.to} failed: ${messageOf(cause)}`,
        };
      }
      if (candidates.length > 0) {
        let restored: unknown;
        try {
          restored = lens
            ? lens.up(current, ctx)
            : (code as ContractCodeStep).up(current, ctx);
        } catch {
          restored = undefined;
        }
        for (const path of candidates) {
          if (
            canonicalJson(valuesAt(before, path)) !==
            canonicalJson(valuesAt(restored, path))
          )
            lossy.add(path);
        }
      }
      for (const path of lens ? lens.derivedDown : (code?.downDerives ?? []))
        derived.add(path);
    }
  }

  return {
    ok: true,
    value: current,
    lossyPaths: [...lossy],
    derivedPaths: [...derived],
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Whether a lens path names a value that is present. A `list[].field` segment (how `map` reports
 * paths) is present when any element has it.
 */
export function hasPath(value: unknown, path: string): boolean {
  const walk = (scope: unknown, segments: readonly string[]): boolean => {
    if (segments.length === 0) return scope !== undefined;
    if (typeof scope !== 'object' || scope === null) return false;
    const [head, ...rest] = segments as [string, ...string[]];
    if (head.endsWith('[]')) {
      const list = (scope as Record<string, unknown>)[head.slice(0, -2)];
      return Array.isArray(list) && list.some((element) => walk(element, rest));
    }
    return walk((scope as Record<string, unknown>)[head], rest);
  };
  return walk(value, path.split('.'));
}

/** Every value a lens path names: one for a plain path, one per element under a `list[]` segment. */
function valuesAt(value: unknown, path: string): unknown[] {
  const walk = (scope: unknown, segments: readonly string[]): unknown[] => {
    if (segments.length === 0) return [scope ?? null];
    if (typeof scope !== 'object' || scope === null) return [null];
    const [head, ...rest] = segments as [string, ...string[]];
    if (head.endsWith('[]')) {
      const list = (scope as Record<string, unknown>)[head.slice(0, -2)];
      return Array.isArray(list)
        ? list.flatMap((element) => walk(element, rest))
        : [null];
    }
    return walk((scope as Record<string, unknown>)[head], rest);
  };
  return walk(value, path.split('.'));
}

/** Whether `path` is `prefix` or lies under it — `price.amount` is under `price`. */
export function pathWithin(path: string, prefix: string): boolean {
  const normalize = (p: string): string => p.replace(/\[\]/g, '');
  const a = normalize(path);
  const b = normalize(prefix);
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}
