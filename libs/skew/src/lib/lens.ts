import type { MigrationContext } from './context.js';

/**
 * Declarative migration ops — the data-driven alternative to closure
 * migrations.
 *
 * A closure can express any migration but can only travel inside the bundle
 * that compiled it. An ops list is data: it can be published by an API,
 * fetched by a build that has never seen the newer shape, audited by a human,
 * and — because every op is structural — **mechanically inverted**, so
 * declaring the up-migration buys the down-migration for free.
 *
 * The op set is deliberately closed and non-Turing-complete. Nothing fetched
 * over the network is ever executed as code; it is interpreted, op by op,
 * against a whitelist. Semantic transforms ("split this name into first and
 * last") do not belong here — they stay as named code steps, and a reader
 * that lacks the named function degrades loudly rather than guessing.
 *
 * Directionality: ops describe the **up** migration (older shape → newer
 * shape). The inverse of each op, where one exists, is derived:
 *
 * | op        | up (old → new)                          | down (new → old)                     |
 * | --------- | --------------------------------------- | ------------------------------------ |
 * | `rename`  | move value `from` → `to`                | move value `to` → `from`             |
 * | `move`    | alias of `rename`                       | reversed                             |
 * | `wrap`    | scalar → `{ [key]: scalar, ...also }`   | object → its `[key]`; `also` dropped |
 * | `hoist`   | object → its `[key]` member             | `[key]` re-wrapped (siblings lost)   |
 * | `map`     | sub-ops over each array element         | inverted sub-ops, reversed           |
 * | `default` | set `path` when absent                  | delete `path` (lossy)                |
 * | `drop`    | delete `path`                           | set `restore` if given, else none    |
 * | `convert` | coerce / map the value at `path`        | opposite coercion / inverted map     |
 * | `const`   | set `path` unconditionally              | delete `path` (lossy)                |
 */

/**
 * A value computed while applying an op:
 * - `{ $now: true }` — `ctx.now().toISOString()`. Derived by definition.
 * - `{ $from: 'path' }` — copied from another field. A leading `/` resolves
 *   against the document root (useful inside `map`, where the scope is the
 *   array element); otherwise against the current scope. Real data, not a
 *   guess.
 * - `{ $value: x }` — the literal `x`, for literals that would otherwise be
 *   mistaken for one of the specs above. Derived by definition.
 * - anything else — itself, as a literal. Derived by definition.
 */
export type LensValueSpec =
  | { readonly $now: true }
  | { readonly $from: string }
  | { readonly $value: unknown }
  | unknown;

export type LensOp =
  | { readonly rename: { readonly from: string; readonly to: string } }
  | { readonly move: { readonly from: string; readonly to: string } }
  | {
      readonly wrap: {
        readonly path: string;
        readonly key: string;
        readonly also?: Readonly<Record<string, LensValueSpec>>;
      };
    }
  | { readonly hoist: { readonly path: string; readonly key: string } }
  | { readonly map: { readonly path: string; readonly ops: readonly LensOp[] } }
  | {
      readonly default: {
        readonly path: string;
        readonly value: unknown;
        /** Defaults to `true` — a filled-in default is a guess by definition. */
        readonly derived?: boolean;
      };
    }
  | {
      readonly drop: {
        readonly path: string;
        /**
         * Value the down-migration reinstates for the field the newer shape
         * removed. Without it the step cannot travel downward at all.
         */
        readonly restore?: unknown;
      };
    }
  | {
      readonly convert: {
        readonly path: string;
        readonly to: 'string' | 'number';
        /**
         * Explicit value mapping (keys are `String(oldValue)`). Invertible
         * only when bijective. Without `via`, `'string'` and `'number'` are
         * treated as inverses of each other.
         */
        readonly via?: Readonly<Record<string, unknown>>;
      };
    }
  | {
      readonly const: {
        readonly path: string;
        readonly value: unknown;
        /** Defaults to `false` — use `true` when the constant is a placeholder. */
        readonly derived?: boolean;
      };
    };

export interface CompiledLens {
  /** Applies the ops in order. Clones the input; never mutates it. */
  readonly up: (data: unknown, ctx: MigrationContext) => unknown;
  /**
   * Applies the inverted ops in reverse order, or `null` when any op is not
   * invertible (see {@link CompiledLens.invertible}).
   */
  readonly down: ((data: unknown, ctx: MigrationContext) => unknown) | null;
  readonly invertible: boolean;
  /** Paths the up direction fills with guesses (statically known). */
  readonly derivedUp: readonly string[];
  /** Paths the down direction fills with guesses (`drop.restore`). */
  readonly derivedDown: readonly string[];
  /** Paths the down direction discards — the cost of the projection. */
  readonly lossyDown: readonly string[];
}

// --- path helpers -----------------------------------------------------------

/**
 * Segments no path may contain. Ops come from documents fetched over the network, and a path such
 * as `__proto__.polluted` would walk off the payload onto `Object.prototype` — a write there
 * changes every object in the process.
 */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function segmentsOf(path: string): string[] {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError(`lens: op path must be a non-empty string, got ${JSON.stringify(path)}`);
  }
  const segments = path.split('.');
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      throw new TypeError(`lens: op path ${JSON.stringify(path)} may not contain "${segment}"`);
    }
  }
  return segments;
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** Reads own properties only: a payload never yields something it inherited. */
function getAt(scope: unknown, segments: readonly string[]): unknown {
  let current: unknown = scope;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) return undefined;
    if (!hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function setAt(scope: unknown, segments: readonly string[], value: unknown): void {
  let current = scope as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i] as string;
    const next = hasOwn(current, segment) ? current[segment] : undefined;
    if (typeof next !== 'object' || next === null) {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    } else {
      current = next as Record<string, unknown>;
    }
  }
  current[segments[segments.length - 1] as string] = value;
}

function deleteAt(scope: unknown, segments: readonly string[]): void {
  // Walk down, remembering the chain so empties can be pruned on the way up.
  const parents: Record<string, unknown>[] = [];
  let current: unknown = scope;
  for (let i = 0; i < segments.length - 1; i++) {
    if (typeof current !== 'object' || current === null) return;
    parents.push(current as Record<string, unknown>);
    const segment = segments[i] as string;
    current = hasOwn(current, segment) ? (current as Record<string, unknown>)[segment] : undefined;
  }
  if (typeof current !== 'object' || current === null) return;
  delete (current as Record<string, unknown>)[segments[segments.length - 1] as string];

  // An intermediate object this deletion emptied was (in the shapes lenses
  // describe) created *for* the deleted field — an up-migration's `move` or
  // `default` built it on the way in. Leaving `liquidity: {}` behind on the
  // way down would put a field in the projection that the older shape never
  // had. Prune upward until a non-empty ancestor stops us; the root scope is
  // never pruned.
  let child = current as Record<string, unknown>;
  for (let i = parents.length - 1; i >= 0; i--) {
    if (Array.isArray(child) || Object.keys(child).length > 0) break;
    const parent = parents[i] as Record<string, unknown>;
    delete parent[segments[i] as string];
    child = parent;
  }
}

// --- value specs ------------------------------------------------------------

interface ResolvedSpec {
  readonly resolve: (scope: unknown, root: unknown, ctx: MigrationContext) => unknown;
  /** Whether the produced value is a guess rather than copied data. */
  readonly derived: boolean;
}

function compileValueSpec(spec: LensValueSpec): ResolvedSpec {
  if (typeof spec === 'object' && spec !== null && !Array.isArray(spec)) {
    const record = spec as Record<string, unknown>;
    if (record['$now'] === true) {
      return { resolve: (_scope, _root, ctx) => ctx.now().toISOString(), derived: true };
    }
    if (typeof record['$from'] === 'string') {
      const path = record['$from'];
      const fromRoot = path.startsWith('/');
      const segments = segmentsOf(fromRoot ? path.slice(1) : path);
      return {
        resolve: (scope, root) => getAt(fromRoot ? root : scope, segments),
        derived: false,
      };
    }
    if ('$value' in record) {
      const literal = record['$value'];
      return { resolve: () => literal, derived: true };
    }
  }
  return { resolve: () => spec, derived: true };
}

// --- op compilation ---------------------------------------------------------

type Applier = (scope: unknown, root: unknown, ctx: MigrationContext) => void;

interface CompiledOp {
  readonly up: Applier;
  /** `null` when the op cannot travel downward. */
  readonly down: Applier | null;
  readonly derivedUp: readonly string[];
  readonly derivedDown: readonly string[];
  readonly lossyDown: readonly string[];
}

function fail(message: string): never {
  throw new TypeError(`lens: ${message}`);
}

function compileOp(op: LensOp): CompiledOp {
  if (typeof op !== 'object' || op === null) fail(`op must be an object, got ${JSON.stringify(op)}`);
  const keys = Object.keys(op);
  if (keys.length !== 1) fail(`op must have exactly one key, got ${JSON.stringify(keys)}`);
  const kind = keys[0] as string;

  switch (kind) {
    case 'rename':
    case 'move': {
      const { from, to } = (op as { rename: { from: string; to: string } }).rename ??
        (op as { move: { from: string; to: string } }).move;
      const fromSegments = segmentsOf(from);
      const toSegments = segmentsOf(to);
      const moveValue = (source: readonly string[], target: readonly string[]): Applier => {
        return (scope) => {
          const value = getAt(scope, source);
          deleteAt(scope, source);
          if (value !== undefined) setAt(scope, target, value);
        };
      };
      return {
        up: moveValue(fromSegments, toSegments),
        down: moveValue(toSegments, fromSegments),
        derivedUp: [],
        derivedDown: [],
        lossyDown: [],
      };
    }

    case 'wrap': {
      const { path, key, also } = (op as { wrap: { path: string; key: string; also?: Record<string, LensValueSpec> } })
        .wrap;
      const segments = segmentsOf(path);
      if (typeof key !== 'string' || key.length === 0) fail(`wrap at "${path}" needs a non-empty key`);
      for (const name of [key, ...Object.keys(also ?? {})]) {
        if (FORBIDDEN_SEGMENTS.has(name)) fail(`wrap at "${path}" may not use the key "${name}"`);
      }
      const alsoEntries = Object.entries(also ?? {}).map(
        ([alsoKey, spec]) => [alsoKey, compileValueSpec(spec)] as const,
      );
      return {
        up: (scope, root, ctx) => {
          const scalar = getAt(scope, segments);
          const wrapped: Record<string, unknown> = { [key]: scalar };
          for (const [alsoKey, spec] of alsoEntries) {
            wrapped[alsoKey] = spec.resolve(scope, root, ctx);
          }
          setAt(scope, segments, wrapped);
        },
        down: (scope) => {
          const wrapped = getAt(scope, segments);
          if (typeof wrapped !== 'object' || wrapped === null) {
            throw new Error(`lens: expected an object at "${path}" to unwrap "${key}" from`);
          }
          setAt(scope, segments, (wrapped as Record<string, unknown>)[key]);
        },
        derivedUp: alsoEntries.filter(([, spec]) => spec.derived).map(([alsoKey]) => `${path}.${alsoKey}`),
        derivedDown: [],
        // Everything wrap added beside the original scalar is discarded on the
        // way down — that is the information the older shape cannot carry.
        lossyDown: alsoEntries.map(([alsoKey]) => `${path}.${alsoKey}`),
      };
    }

    case 'hoist': {
      const { path, key } = (op as { hoist: { path: string; key: string } }).hoist;
      const segments = segmentsOf(path);
      if (typeof key !== 'string' || key.length === 0) fail(`hoist at "${path}" needs a non-empty key`);
      if (FORBIDDEN_SEGMENTS.has(key)) fail(`hoist at "${path}" may not use the key "${key}"`);
      return {
        up: (scope) => {
          const source = getAt(scope, segments);
          if (typeof source !== 'object' || source === null) {
            throw new Error(`lens: expected an object at "${path}" to hoist "${key}" from`);
          }
          setAt(scope, segments, (source as Record<string, unknown>)[key]);
        },
        down: (scope) => {
          setAt(scope, segments, { [key]: getAt(scope, segments) });
        },
        derivedUp: [],
        derivedDown: [],
        lossyDown: [],
      };
    }

    case 'map': {
      const { path, ops } = (op as { map: { path: string; ops: readonly LensOp[] } }).map;
      const segments = segmentsOf(path);
      const inner = compileOps(ops);
      const overArray = (apply: readonly Applier[]): Applier => {
        return (scope, root, ctx) => {
          const list = getAt(scope, segments);
          if (list === undefined) return;
          if (!Array.isArray(list)) throw new Error(`lens: expected an array at "${path}" to map over`);
          for (const element of list) {
            for (const step of apply) step(element, root, ctx);
          }
        };
      };
      const prefix = (paths: readonly string[]) => paths.map((p) => `${path}[].${p}`);
      return {
        up: overArray(inner.ops.map((o) => o.up)),
        down: inner.invertible
          ? overArray(
              [...inner.ops].reverse().map((o) => o.down as Applier),
            )
          : null,
        derivedUp: prefix(inner.derivedUp),
        derivedDown: prefix(inner.derivedDown),
        lossyDown: prefix(inner.lossyDown),
      };
    }

    case 'default': {
      const { path, value, derived = true } = (
        op as { default: { path: string; value: unknown; derived?: boolean } }
      ).default;
      const segments = segmentsOf(path);
      return {
        up: (scope) => {
          if (getAt(scope, segments) === undefined) setAt(scope, segments, structuredClone(value));
        },
        down: (scope) => deleteAt(scope, segments),
        derivedUp: derived ? [path] : [],
        derivedDown: [],
        lossyDown: [path],
      };
    }

    case 'drop': {
      const dropOp = (op as { drop: { path: string; restore?: unknown } }).drop;
      const segments = segmentsOf(dropOp.path);
      const restorable = 'restore' in dropOp;
      return {
        up: (scope) => deleteAt(scope, segments),
        down: restorable ? (scope) => setAt(scope, segments, structuredClone(dropOp.restore)) : null,
        derivedUp: [],
        derivedDown: restorable ? [dropOp.path] : [],
        lossyDown: [],
      };
    }

    case 'convert': {
      const { path, to, via } = (
        op as { convert: { path: string; to: 'string' | 'number'; via?: Record<string, unknown> } }
      ).convert;
      const segments = segmentsOf(path);
      if (to !== 'string' && to !== 'number') fail(`convert at "${path}" must target 'string' or 'number'`);

      const coerce = (target: 'string' | 'number', table: Record<string, unknown> | null): Applier => {
        return (scope) => {
          const current = getAt(scope, segments);
          if (current === undefined) return;
          if (table) {
            // Own entries only: a value of "constructor" has no mapping, it does not map to a
            // function inherited from Object.prototype.
            const key = String(current);
            const mapped = hasOwn(table, key) ? table[key] : undefined;
            if (mapped === undefined) {
              throw new Error(`lens: convert at "${path}" has no mapping for ${JSON.stringify(current)}`);
            }
            setAt(scope, segments, mapped);
            return;
          }
          const converted = target === 'string' ? String(current) : Number(current);
          if (target === 'number' && Number.isNaN(converted)) {
            throw new Error(`lens: convert at "${path}" could not read ${JSON.stringify(current)} as a number`);
          }
          setAt(scope, segments, converted);
        };
      };

      let inverseTable: Record<string, unknown> | null = null;
      let invertible = true;
      if (via) {
        inverseTable = Object.create(null) as Record<string, unknown>;
        for (const [key, mapped] of Object.entries(via)) {
          const inverseKey = String(mapped);
          if (inverseKey in inverseTable) {
            // Two old values map to the same new one — the down direction
            // cannot know which to restore.
            invertible = false;
            break;
          }
          inverseTable[inverseKey] = coerceKeyBack(key, to === 'string' ? 'number' : 'string');
        }
      }

      return {
        up: coerce(to, via ?? null),
        down: invertible ? coerce(to === 'string' ? 'number' : 'string', inverseTable) : null,
        derivedUp: [],
        derivedDown: [],
        lossyDown: [],
      };
    }

    case 'const': {
      const { path, value, derived = false } = (
        op as { const: { path: string; value: unknown; derived?: boolean } }
      ).const;
      const segments = segmentsOf(path);
      return {
        up: (scope) => setAt(scope, segments, structuredClone(value)),
        down: (scope) => deleteAt(scope, segments),
        derivedUp: derived ? [path] : [],
        derivedDown: [],
        lossyDown: [path],
      };
    }

    default:
      return fail(`unknown op "${kind}"`);
  }
}

/**
 * `via` keys arrive as strings (JSON object keys always are). When the down
 * direction restores an *old* value that was numeric, give it back as the
 * number it was.
 */
function coerceKeyBack(key: string, oldKind: 'string' | 'number'): unknown {
  if (oldKind !== 'number') return key;
  const numeric = Number(key);
  return Number.isNaN(numeric) ? key : numeric;
}

interface CompiledOps {
  readonly ops: readonly CompiledOp[];
  readonly invertible: boolean;
  readonly derivedUp: readonly string[];
  readonly derivedDown: readonly string[];
  readonly lossyDown: readonly string[];
}

function compileOps(ops: readonly LensOp[]): CompiledOps {
  if (!Array.isArray(ops)) fail('ops must be an array');
  const compiled = ops.map(compileOp);
  return {
    ops: compiled,
    invertible: compiled.every((o) => o.down !== null),
    derivedUp: compiled.flatMap((o) => o.derivedUp),
    derivedDown: compiled.flatMap((o) => o.derivedDown),
    lossyDown: compiled.flatMap((o) => o.lossyDown),
  };
}

/**
 * Compiles an ops list into executable up and (when possible) down
 * migrations. Throws `TypeError` on a malformed ops list — a bad contract is
 * a programming error and should fail at declaration, not at read time.
 */
export function compileLens(ops: readonly LensOp[]): CompiledLens {
  const compiled = compileOps(ops);

  const up = (data: unknown, ctx: MigrationContext): unknown => {
    const draft = structuredClone(data);
    for (const op of compiled.ops) op.up(draft, draft, ctx);
    return draft;
  };

  const down = compiled.invertible
    ? (data: unknown, ctx: MigrationContext): unknown => {
        const draft = structuredClone(data);
        for (const op of [...compiled.ops].reverse()) (op.down as Applier)(draft, draft, ctx);
        return draft;
      }
    : null;

  return {
    up,
    down,
    invertible: compiled.invertible,
    derivedUp: compiled.derivedUp,
    derivedDown: compiled.derivedDown,
    lossyDown: compiled.lossyDown,
  };
}
