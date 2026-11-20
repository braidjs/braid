/**
 * The A2UI regex dialect, and its static safety check (A2UI v1.0, "The regex function").
 *
 * A pattern arrives from an agent, so it is untrusted, and a regular expression is the one place in
 * a declarative format where data can make a renderer spin: a pattern that backtracks
 * catastrophically freezes the page it runs in. So a pattern is parsed here, in the dialect the
 * spec allows, and refused if it could backtrack — before a `RegExp` is ever built from it:
 *
 * 1. longer than 256 code points;
 * 2. a quantifier with an upper bound above 1 over something containing an unbounded quantifier;
 * 3. an unbounded quantifier over an alternation two of whose branches can start with one character;
 * 4. two unbounded atoms whose character sets overlap, with only things that can match nothing
 *    between them.
 *
 * What passes is compiled with the `u` flag and nothing else, which gives the dialect's matching
 * semantics: `.` excludes line terminators, `^`/`$` anchor the whole value, `\d \w \b` are ASCII.
 */

export const REGEX_LIMITS = Object.freeze({
  patternCodePoints: 256,
  valueCodePoints: 4_096,
});

type Range = readonly [number, number];
/** A set of code points, as sorted, non-overlapping ranges. */
type CharSet = readonly Range[];

const MAX = 0x10ffff;
const ranges = (...pairs: [number, number][]): CharSet => normalise(pairs);
function normalise(pairs: readonly Range[]): CharSet {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}
function complement(set: CharSet): CharSet {
  const out: [number, number][] = [];
  let next = 0;
  for (const [lo, hi] of set) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX) out.push([next, MAX]);
  return out;
}
const union = (...sets: CharSet[]): CharSet => normalise(sets.flat());
function overlaps(a: CharSet, b: CharSet): boolean {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const [alo, ahi] = a[i] as Range;
    const [blo, bhi] = b[j] as Range;
    if (alo <= bhi && blo <= ahi) return true;
    if (ahi < bhi) i++;
    else j++;
  }
  return false;
}

const DIGIT = ranges([48, 57]);
const WORD = ranges([48, 57], [65, 90], [95, 95], [97, 122]);
const SPACE = ranges(
  [9, 13],
  [32, 32],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
);
const LINE_TERMINATORS = ranges([10, 10], [13, 13], [0x2028, 0x2029]);
const DOT = complement(LINE_TERMINATORS);

type Node =
  | { readonly kind: 'alt'; readonly branches: readonly Seq[] }
  | { readonly kind: 'char'; readonly set: CharSet }
  | { readonly kind: 'group'; readonly body: Node }
  | { readonly kind: 'look'; readonly body: Node; readonly negate: boolean }
  | { readonly kind: 'assert'; readonly which: '^' | '$' | 'b' | 'B' };
type Seq = readonly Item[];
interface Item {
  readonly atom: Node;
  readonly min: number;
  readonly max: number; // Infinity for unbounded
}

/** The largest bound a counted repeat may name: `{0,1000}`. */
const MAX_COUNT = 1_000;

export class RegexDialectError extends Error {
  override readonly name = 'RegexDialectError';
}

const SYNTAX = new Set('^$\\.*+?()[]{}|/-'.split(''));

/** Parses a pattern in the dialect. Throws {@link RegexDialectError} for what the dialect does not allow. */
function parse(source: string): Node {
  const chars = [...source];
  let at = 0;
  const peek = (offset = 0): string | undefined => chars[at + offset];
  const fail = (message: string): never => {
    throw new RegexDialectError(`${message} (at ${at})`);
  };
  const eat = (expected: string): void => {
    if (chars[at] !== expected) fail(`expected "${expected}"`);
    at++;
  };

  const hex = (count: number): number => {
    const digits = chars.slice(at, at + count).join('');
    if (digits.length !== count || !/^[0-9a-fA-F]+$/.test(digits))
      fail('a malformed hex escape');
    at += count;
    return parseInt(digits, 16);
  };

  /** An escape after `\`; returns a set, or `null` for a zero-width `\b`/`\B`. */
  const escape = (inClass: boolean): CharSet | null => {
    const c = chars[at++];
    if (c === undefined) return fail('a pattern cannot end in "\\"');
    switch (c) {
      case 'd':
        return DIGIT;
      case 'D':
        return complement(DIGIT);
      case 'w':
        return WORD;
      case 'W':
        return complement(WORD);
      case 's':
        return SPACE;
      case 'S':
        return complement(SPACE);
      case 'b':
      case 'B':
        if (inClass) return fail('"\\b" is not allowed in a class');
        return null;
      case 't':
        return ranges([9, 9]);
      case 'n':
        return ranges([10, 10]);
      case 'v':
        return ranges([11, 11]);
      case 'f':
        return ranges([12, 12]);
      case 'r':
        return ranges([13, 13]);
      case '0':
        if (peek() !== undefined && /\d/.test(peek() as string))
          return fail('legacy octal escapes are not allowed');
        return ranges([0, 0]);
      case 'x': {
        const code = hex(2);
        return ranges([code, code]);
      }
      case 'u': {
        if (peek() === '{') {
          at++;
          let digits = '';
          while (peek() !== '}' && digits.length < 7)
            digits += chars[at++] ?? '';
          eat('}');
          if (!/^[0-9a-fA-F]{1,6}$/.test(digits) || parseInt(digits, 16) > MAX)
            fail('a malformed \\u{…} escape');
          const code = parseInt(digits, 16);
          return ranges([code, code]);
        }
        const code = hex(4);
        return ranges([code, code]);
      }
      case 'p':
      case 'P':
        return fail('"\\p{…}" is not allowed');
      case 'c':
        return fail('"\\cX" is not allowed');
      case 'k':
        return fail('named backreferences are not allowed');
      default:
        if (/[1-9]/.test(c)) return fail('backreferences are not allowed');
        if (SYNTAX.has(c))
          return ranges([
            c.codePointAt(0) as number,
            c.codePointAt(0) as number,
          ]);
        return fail(`"\\${c}" is not an escape the dialect allows`);
    }
  };

  const classAtom = (): CharSet => {
    if (peek() === '\\') {
      at++;
      return escape(true) as CharSet;
    }
    const c = chars[at++];
    if (c === undefined) return fail('an unterminated class');
    return ranges([c.codePointAt(0) as number, c.codePointAt(0) as number]);
  };

  const charClass = (): CharSet => {
    eat('[');
    const negate = peek() === '^';
    if (negate) at++;
    const parts: CharSet[] = [];
    while (peek() !== ']') {
      if (peek() === undefined) fail('an unterminated class');
      const first = classAtom();
      if (peek() === '-' && peek(1) !== ']' && peek(1) !== undefined) {
        at++;
        const second = classAtom();
        const [lo] = first[0] ?? [0];
        const [hi] = second[0] ?? [0];
        if (
          first.length !== 1 ||
          second.length !== 1 ||
          first[0]?.[0] !== first[0]?.[1] ||
          second[0]?.[0] !== second[0]?.[1]
        )
          fail('a class range needs a single character at each end');
        if (lo > hi) fail('a class range out of order');
        parts.push(ranges([lo, hi]));
      } else parts.push(first);
    }
    eat(']');
    const set = union(...parts);
    return negate ? complement(set) : set;
  };

  const atom = (): Node | null => {
    const c = peek();
    switch (c) {
      case '(': {
        at++;
        if (peek() === '?') {
          at++;
          const kind = chars[at++];
          if (kind === ':') {
            const body = alternation();
            eat(')');
            return { kind: 'group', body };
          }
          if (kind === '=' || kind === '!') {
            const body = alternation();
            eat(')');
            return { kind: 'look', body, negate: kind === '!' };
          }
          if (kind === '<')
            return fail(
              peek() === '=' || peek() === '!'
                ? 'lookbehind is not allowed'
                : 'named groups are not allowed',
            );
          return fail('inline flags are not allowed');
        }
        const body = alternation();
        eat(')');
        return { kind: 'group', body };
      }
      case '[':
        return { kind: 'char', set: charClass() };
      case '.':
        at++;
        return { kind: 'char', set: DOT };
      case '^':
      case '$':
        at++;
        return { kind: 'assert', which: c };
      case '\\': {
        at++;
        const which = chars[at] === 'B' ? 'B' : 'b';
        const set = escape(false);
        return set === null ? { kind: 'assert', which } : { kind: 'char', set };
      }
      case ')':
      case '|':
      case undefined:
        return null;
      case '*':
      case '+':
      case '?':
        return fail(`"${c}" has nothing to repeat`);
      case '{':
        if (/^\{\d/.test(chars.slice(at, at + 2).join('')))
          return fail('"{" has nothing to repeat');
        at++;
        return { kind: 'char', set: ranges([123, 123]) };
      case ']':
      case '}':
        at++;
        return {
          kind: 'char',
          set: ranges([c.codePointAt(0) as number, c.codePointAt(0) as number]),
        };
      default:
        at++;
        return {
          kind: 'char',
          set: ranges([c.codePointAt(0) as number, c.codePointAt(0) as number]),
        };
    }
  };

  const quantifier = (): { min: number; max: number } | null => {
    const c = peek();
    let bounds: { min: number; max: number } | null = null;
    if (c === '*') bounds = { min: 0, max: Infinity };
    else if (c === '+') bounds = { min: 1, max: Infinity };
    else if (c === '?') bounds = { min: 0, max: 1 };
    else if (c === '{') {
      const rest = chars.slice(at).join('');
      const match = /^\{(\d{1,5})(,(\d{0,5}))?\}/.exec(rest);
      if (!match) return null;
      const min = Number(match[1]);
      const max =
        match[2] === undefined
          ? min
          : match[3] === ''
            ? Infinity
            : Number(match[3]);
      if (max < min) fail('a quantifier out of order');
      if (min > MAX_COUNT || (max !== Infinity && max > MAX_COUNT))
        fail(`a counted repeat above ${MAX_COUNT}`);
      at += match[0].length - 1;
      bounds = { min, max };
    }
    if (!bounds) return null;
    at++;
    if (peek() === '?') at++; // lazy: the same bounds
    return bounds;
  };

  const sequence = (): Seq => {
    const items: Item[] = [];
    for (;;) {
      const node = atom();
      if (node === null) return items;
      const bounds = quantifier();
      if (bounds && node.kind === 'assert')
        fail('an assertion cannot be repeated');
      items.push({ atom: node, min: bounds?.min ?? 1, max: bounds?.max ?? 1 });
    }
  };

  const alternation = (): Node => {
    const branches: Seq[] = [sequence()];
    while (peek() === '|') {
      at++;
      branches.push(sequence());
    }
    return { kind: 'alt', branches };
  };

  const tree = alternation();
  if (at !== chars.length) fail(`an unmatched "${chars[at]}"`);
  return tree;
}

// --- analysis -----------------------------------------------------------------------------------

/** A group whose only content is one quantified atom counts as that atom (the spec's words). */
function unwrap(item: Item): Item {
  let current = item;
  for (;;) {
    const { atom } = current;
    if (
      atom.kind !== 'group' ||
      atom.body.kind !== 'alt' ||
      atom.body.branches.length !== 1
    )
      return current;
    const only = atom.body.branches[0] as Seq;
    if (only.length !== 1) return current;
    const inner = only[0] as Item;
    if (current.min !== 1 || current.max !== 1) {
      // A quantified group of one quantified atom: the outer bounds apply to it (rule 2 sees it).
      return current;
    }
    current = inner;
  }
}

function nullableNode(node: Node): boolean {
  switch (node.kind) {
    case 'alt':
      return node.branches.some((seq) => seq.every(nullableItem));
    case 'group':
      return nullableNode(node.body);
    case 'look':
    case 'assert':
      return true;
    case 'char':
      return false;
  }
}
const nullableItem = (item: Item): boolean =>
  item.min === 0 || nullableNode(item.atom);
const zeroWidth = (item: Item): boolean =>
  item.atom.kind === 'look' || item.atom.kind === 'assert';

/** Every character the node can consume. */
function charsOf(node: Node): CharSet {
  switch (node.kind) {
    case 'char':
      return node.set;
    case 'group':
      return charsOf(node.body);
    case 'alt':
      return union(
        ...node.branches.flatMap((seq) =>
          seq.map((item) => charsOf(item.atom)),
        ),
      );
    default:
      return [];
  }
}

/** The characters a match of the node can start with. */
function firstOf(node: Node): CharSet {
  switch (node.kind) {
    case 'char':
      return node.set;
    case 'group':
      return firstOf(node.body);
    case 'alt':
      return union(...node.branches.map(firstOfSeq));
    default:
      return [];
  }
}
function firstOfSeq(seq: Seq): CharSet {
  const parts: CharSet[] = [];
  for (const item of seq) {
    if (zeroWidth(item)) continue;
    parts.push(firstOf(item.atom));
    if (!nullableItem(item)) break;
  }
  return union(...parts);
}

function containsUnbounded(node: Node): boolean {
  switch (node.kind) {
    case 'alt':
      return node.branches.some((seq) =>
        seq.some(
          (item) => item.max === Infinity || containsUnbounded(item.atom),
        ),
      );
    case 'group':
    case 'look':
      return containsUnbounded(node.body);
    default:
      return false;
  }
}

function check(node: Node): void {
  if (node.kind === 'group' || node.kind === 'look') return check(node.body);
  if (node.kind !== 'alt') return;
  for (const seq of node.branches) {
    for (const raw of seq) {
      const item = unwrap(raw);
      // Rule 2: a repeat (upper bound above 1) over something that repeats without bound.
      if (item.max > 1 && containsUnbounded(item.atom))
        throw new RegexDialectError(
          'a repeated group contains an unbounded repeat, which can backtrack catastrophically',
        );
      // Rule 3: an unbounded repeat over an alternation whose branches can start alike.
      if (item.max === Infinity) {
        const body = item.atom.kind === 'group' ? item.atom.body : item.atom;
        if (body.kind === 'alt' && body.branches.length > 1) {
          const firsts = body.branches.map(firstOfSeq);
          for (let a = 0; a < firsts.length; a++)
            for (let b = a + 1; b < firsts.length; b++)
              if (overlaps(firsts[a] as CharSet, firsts[b] as CharSet))
                throw new RegexDialectError(
                  'an unbounded repeat over alternatives that can start with the same character can backtrack catastrophically',
                );
        }
      }
      check(item.atom);
    }
    // Rule 4: unbounded atoms with overlapping characters, nothing that must match between them.
    const items = seq.map(unwrap);
    for (let i = 0; i < items.length; i++) {
      const left = items[i] as Item;
      if (left.max !== Infinity) continue;
      const leftChars = charsOf(left.atom);
      for (let j = i + 1; j < items.length; j++) {
        const right = items[j] as Item;
        if (zeroWidth(right)) continue;
        if (right.max === Infinity && overlaps(leftChars, charsOf(right.atom)))
          throw new RegexDialectError(
            'two unbounded repeats of overlapping characters are adjacent, which can backtrack catastrophically',
          );
        if (!nullableItem(right)) break;
      }
    }
  }
}

// --- matching ----------------------------------------------------------------------------------

/**
 * Matching, without backtracking: the pattern is compiled to an NFA and run as a Pike VM — every
 * thread advanced in lockstep, one step per code point — so time grows with pattern × value, never
 * exponentially, whatever a pattern does. The static rules above are the spec's; this is what
 * makes a pattern they miss harmless. A lookahead is a sub-machine run from the position it
 * guards, its answer remembered per position. A step budget bounds the whole of one match.
 */
type Instruction =
  | { readonly op: 'char'; readonly set: CharSet }
  | { readonly op: 'split'; readonly x: number; readonly y: number }
  | { readonly op: 'jmp'; readonly to: number }
  | { readonly op: 'assert'; readonly which: '^' | '$' | 'b' | 'B' }
  | { readonly op: 'look'; readonly program: Program; readonly negate: boolean }
  | { readonly op: 'match' };
type Program = Instruction[];

/** How large a compiled pattern may be: counted repeats are copies, so `(…){1000}` is big. */
export const MAX_INSTRUCTIONS = 20_000;
/** Thread steps one match may take, lookaheads included. */
export const MATCH_STEP_BUDGET = 5_000_000;

/**
 * How many instructions a pattern compiles to, worked out before compiling — so that a short
 * pattern of nested counted repeats is refused instead of built. A lookahead is compiled once
 * however many copies of it a counted repeat makes, and counted once here.
 */
function estimate(node: Node, looks = new Set<Node>()): number {
  const over = MAX_INSTRUCTIONS + 1;
  const size = (n: Node): number => {
    switch (n.kind) {
      case 'char':
      case 'assert':
        return 1;
      case 'look': {
        if (looks.has(n)) return 1;
        looks.add(n);
        return Math.min(over, 2 + size(n.body));
      }
      case 'group':
        return size(n.body);
      case 'alt': {
        let total = 0;
        for (const seq of n.branches) {
          total += 2;
          for (const it of seq) {
            const atom = size(it.atom);
            total +=
              it.max === Infinity
                ? it.min * atom + atom + 2
                : it.min * atom + (it.max - it.min) * (atom + 1);
            if (total > MAX_INSTRUCTIONS) return over;
          }
        }
        return total;
      }
    }
  };
  return size(node);
}

/** Instructions across a pattern and all its lookaheads, shared while compiling. */
interface Compiling {
  count: number;
  readonly looks: Map<Node, Program>;
}

function compile(
  node: Node,
  shared: Compiling = { count: 0, looks: new Map() },
): Program {
  const program: Program = [];
  const emit = (instruction: Instruction): number => {
    if (++shared.count > MAX_INSTRUCTIONS)
      throw new RegexDialectError(
        `the pattern compiles to more than ${MAX_INSTRUCTIONS} instructions`,
      );
    program.push(instruction);
    return program.length - 1;
  };
  const patch = (at: number, instruction: Instruction): void => {
    program[at] = instruction;
  };
  const node_ = (n: Node): void => {
    switch (n.kind) {
      case 'char':
        emit({ op: 'char', set: n.set });
        return;
      case 'assert':
        emit({ op: 'assert', which: n.which });
        return;
      case 'look': {
        // One program per lookahead in the pattern, shared by every copy a counted repeat makes,
        // so its answers at each position are worked out once.
        let inner = shared.looks.get(n);
        if (!inner) shared.looks.set(n, (inner = compile(n.body, shared)));
        emit({ op: 'look', program: inner, negate: n.negate });
        return;
      }
      case 'group':
        node_(n.body);
        return;
      case 'alt': {
        // split L1, next; L1: branch; jmp end; next: split … — the last branch falls through
        const jumps: number[] = [];
        n.branches.forEach((seq, index) => {
          if (index < n.branches.length - 1) {
            const split = emit({ op: 'jmp', to: -1 });
            seq.forEach(item);
            jumps.push(emit({ op: 'jmp', to: -1 }));
            patch(split, { op: 'split', x: split + 1, y: program.length });
          } else seq.forEach(item);
        });
        for (const jump of jumps)
          patch(jump, { op: 'jmp', to: program.length });
        return;
      }
    }
  };
  const item = (it: Item): void => {
    for (let i = 0; i < it.min; i++) node_(it.atom);
    if (it.max === Infinity) {
      // L: split body, end; body; jmp L
      const loop = emit({ op: 'jmp', to: -1 });
      node_(it.atom);
      emit({ op: 'jmp', to: loop });
      patch(loop, { op: 'split', x: loop + 1, y: program.length });
      return;
    }
    const optional: number[] = [];
    for (let i = it.min; i < it.max; i++) {
      optional.push(emit({ op: 'jmp', to: -1 }));
      node_(it.atom);
    }
    for (const at of optional)
      patch(at, { op: 'split', x: at + 1, y: program.length });
  };
  node_(node);
  emit({ op: 'match' });
  return program;
}

const isWord = (code: number | undefined): boolean =>
  code !== undefined &&
  ((code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122));

function inSet(set: CharSet, code: number): boolean {
  let lo = 0;
  let hi = set.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = set[mid] as Range;
    if (code < a) hi = mid - 1;
    else if (code > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Steps matching may take. One per match by default; a renderer passes one shared by every match
 * in a draw, so that many cheap-looking checks cannot add up to a frozen page.
 */
export class MatchBudget {
  steps = 0;
  constructor(readonly limit: number = MATCH_STEP_BUDGET) {}
  spend(cost = 1): void {
    this.steps += cost;
    if (this.steps > this.limit)
      throw new RegexDialectError('matching took more steps than its budget');
  }
}
type Budget = MatchBudget;

/** Whether `program` matches `codes` starting at `start`; `anchored` stops it searching later starts. */
function run(
  program: Program,
  codes: readonly number[],
  start: number,
  anchored: boolean,
  budget: Budget,
  looks: Map<Program, Map<number, boolean>>,
): boolean {
  // Setting up a run costs its program's length: a lookahead run at every position is paid for.
  budget.spend(program.length);
  const mark = new Int32Array(program.length).fill(-1);
  let generation = 0;
  const look = (
    instruction: Extract<Instruction, { op: 'look' }>,
    at: number,
  ): boolean => {
    let memo = looks.get(instruction.program);
    if (!memo) looks.set(instruction.program, (memo = new Map()));
    let found = memo.get(at);
    if (found === undefined) {
      found = run(instruction.program, codes, at, true, budget, looks);
      memo.set(at, found);
    }
    return instruction.negate ? !found : found;
  };
  /** Follows everything that consumes nothing; returns true on reaching `match`. */
  const add = (list: number[], pc: number, at: number): boolean => {
    const stack = [pc];
    while (stack.length > 0) {
      const p = stack.pop() as number;
      if (mark[p] === generation) continue;
      mark[p] = generation;
      budget.spend();
      const instruction = program[p] as Instruction;
      switch (instruction.op) {
        case 'match':
          return true;
        case 'jmp':
          stack.push(instruction.to);
          break;
        case 'split':
          stack.push(instruction.y, instruction.x);
          break;
        case 'assert': {
          const ok =
            instruction.which === '^'
              ? at === 0
              : instruction.which === '$'
                ? at === codes.length
                : (isWord(codes[at - 1]) !== isWord(codes[at])) ===
                  (instruction.which === 'b');
          if (ok) stack.push(p + 1);
          break;
        }
        case 'look':
          if (look(instruction, at)) stack.push(p + 1);
          break;
        case 'char':
          list.push(p);
          break;
      }
    }
    return false;
  };
  // One generation per position: the threads that reached it, and (searching) a fresh start.
  generation++;
  let list: number[] = [];
  if (add(list, 0, start)) return true;
  for (let at = start; at < codes.length; at++) {
    const code = codes[at] as number;
    generation++;
    const next: number[] = [];
    for (const p of list) {
      budget.spend();
      const instruction = program[p] as Extract<Instruction, { op: 'char' }>;
      if (inSet(instruction.set, code) && add(next, p + 1, at + 1)) return true;
    }
    if (!anchored && add(next, 0, at + 1)) return true;
    if (next.length === 0 && anchored) return false;
    list = next;
  }
  return false;
}

/** A compiled pattern in the A2UI dialect: tested without backtracking. */
export interface A2uiRegex {
  readonly source: string;
  test(value: string, budget?: MatchBudget): boolean;
}

/**
 * A pattern in the A2UI dialect, after the safety check, compiled for linear-time matching.
 * Throws {@link RegexDialectError} — the caller reports it as `EXPRESSION_ERROR`.
 */
export function compileA2uiRegex(pattern: string): A2uiRegex {
  if (typeof pattern !== 'string')
    throw new RegexDialectError('a pattern must be a string');
  if ([...pattern].length > REGEX_LIMITS.patternCodePoints)
    throw new RegexDialectError(
      `a pattern is longer than ${REGEX_LIMITS.patternCodePoints} code points`,
    );
  const tree = parse(pattern);
  check(tree);
  if (estimate(tree) > MAX_INSTRUCTIONS)
    throw new RegexDialectError(
      `the pattern compiles to more than ${MAX_INSTRUCTIONS} instructions`,
    );
  // ECMAScript's own parser has the last word on syntax: a pattern it refuses is not one.
  try {
    new RegExp(pattern, 'u');
  } catch (error) {
    throw new RegexDialectError(
      `not a valid pattern: ${(error as Error).message}`,
    );
  }
  const program = compile(tree);
  return {
    source: pattern,
    test: (value, budget = new MatchBudget()) =>
      run(
        program,
        Array.from(value, (c) => c.codePointAt(0) as number),
        0,
        false,
        budget,
        new Map(),
      ),
  };
}

/** `regex`'s search: a value longer than 4,096 code points does not match, and is not an error. */
export function a2uiRegexMatches(
  regex: A2uiRegex,
  value: string,
  budget?: MatchBudget,
): boolean {
  if ([...value].length > REGEX_LIMITS.valueCodePoints) return false;
  return regex.test(value, budget);
}
