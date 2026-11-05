import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MigrationContext } from './context.js';
import { LensOp, compileLens } from './lens.js';
import { versioned } from './versioned.js';

/**
 * The laws declarative migrations promise, as properties.
 *
 * An ops list is inverted mechanically, so "declaring the up-migration buys the down-migration for
 * free" is a claim about every ops list, not about the handful a spec happens to list. For the
 * lossless ops it is exact: going up and coming back down returns the original document. And a
 * chain of ops steps must mean what its ops mean concatenated, whichever way it is read.
 */

const ctx: MigrationContext = { now: () => new Date('2026-08-10T12:00:00.000Z') };

type Kind = 'int' | 'text' | 'flag' | 'object';
type Scalar = number | string | boolean | null;

const scalar: fc.Arbitrary<{ kind: Kind; value: Scalar }> = fc.oneof(
  fc.integer({ min: -1_000_000, max: 1_000_000 }).map((value) => ({ kind: 'int' as const, value: value === 0 ? 0 : value })),
  // Never a numeric string: those are what a number→string convert produces, and would read back
  // as numbers on the way down.
  fc.string({ maxLength: 6 }).filter((s) => s.trim() === '' || Number.isNaN(Number(s))).map((value) => ({ kind: 'text' as const, value })),
  fc.boolean().map((value) => ({ kind: 'flag' as const, value })),
  fc.constant({ kind: 'flag' as const, value: null }),
);

/** A flat document of 1–5 fields, `k0`…, and what kind of value each holds. */
const documentArb = fc.array(scalar, { minLength: 1, maxLength: 5 }).map((values) => {
  const doc: Record<string, unknown> = {};
  const kinds: Record<string, Kind> = {};
  values.forEach(({ kind, value }, index) => {
    doc[`k${index}`] = value;
    kinds[`k${index}`] = kind;
  });
  return { doc, kinds };
});

/**
 * Lossless ops that are valid against the document as it stands after the ops before them.
 *
 * Built from a list of choices rather than generated directly, so every op names a field that
 * exists, with a value of a kind the op accepts, and every rename lands on a field that does not.
 */
function losslessOps(kinds: Readonly<Record<string, Kind>>, choices: readonly [number, number][], fresh: { n: number }): LensOp[] {
  const current = new Map(Object.entries(kinds));
  const ops: LensOp[] = [];
  for (const [what, which] of choices) {
    const fields = [...current.keys()];
    if (fields.length === 0) break;
    const field = fields[which % fields.length]!;
    const kind = current.get(field)!;
    switch (what % 3) {
      case 0: {
        const to = `r${fresh.n++}`;
        ops.push(which % 2 ? { rename: { from: field, to } } : { move: { from: field, to } });
        current.delete(field);
        current.set(to, kind);
        break;
      }
      case 1:
        if (kind === 'object') break;
        ops.push({ wrap: { path: field, key: 'value' } });
        current.set(field, 'object');
        break;
      default:
        if (kind !== 'int') break;
        ops.push({ convert: { path: field, to: 'string' } });
        current.set(field, 'text');
    }
  }
  return ops;
}

const choicesArb = fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 8 });

const roundTripCase = fc.record({ document: documentArb, choices: choicesArb }).map(({ document, choices }) => ({
  doc: document.doc,
  ops: losslessOps(document.kinds, choices, { n: 0 }),
}));

describe('lens laws', () => {
  it('comes back down to the original document from any lossless ops list', () => {
    fc.assert(
      fc.property(roundTripCase, ({ doc, ops }) => {
        const lens = compileLens(ops);
        expect(lens.invertible).toBe(true);
        expect(lens.lossyDown).toEqual([]);
        expect(lens.down!(lens.up(doc, ctx), ctx)).toEqual(doc);
      }),
      { numRuns: 2_000 },
    );
  });

  it('generates op lists worth checking, with every op kind', () => {
    // A generator that mostly yields empty or one-op lists would pass the law by testing little.
    const sample = fc.sample(roundTripCase, { numRuns: 2_000, seed: 7 });
    const kinds = new Set(sample.flatMap(({ ops }) => ops.map((op) => Object.keys(op)[0])));
    expect([...kinds].sort()).toEqual(['convert', 'move', 'rename', 'wrap']);
    expect(sample.filter(({ ops }) => ops.length >= 3).length / sample.length).toBeGreaterThan(0.4);
  });

  it('never changes the document it is given', () => {
    fc.assert(
      fc.property(roundTripCase, ({ doc, ops }) => {
        const before = structuredClone(doc);
        compileLens(ops).up(doc, ctx);
        expect(doc).toEqual(before);
      }),
      { numRuns: 500 },
    );
  });
});

/** Two ops steps over one document: the second built against the shape the first leaves. */
const chainCase = fc
  .record({ document: documentArb, first: choicesArb, second: choicesArb })
  .map(({ document, first, second }) => {
    const fresh = { n: 0 };
    const ops1 = losslessOps(document.kinds, first, fresh);
    const kindsAfter = kindsAfterOps(document.kinds, ops1);
    const ops2 = losslessOps(kindsAfter, second, fresh);
    return { doc: document.doc, ops1, ops2 };
  });

/** The field kinds once `ops` have run — the same bookkeeping `losslessOps` keeps. */
function kindsAfterOps(kinds: Readonly<Record<string, Kind>>, ops: readonly LensOp[]): Record<string, Kind> {
  const current = new Map(Object.entries(kinds));
  for (const op of ops) {
    if ('rename' in op || 'move' in op) {
      const { from, to } = 'rename' in op ? op.rename : op.move;
      const kind = current.get(from)!;
      current.delete(from);
      current.set(to, kind);
    } else if ('wrap' in op) current.set(op.wrap.path, 'object');
    else if ('convert' in op) current.set(op.convert.path, 'text');
  }
  return Object.fromEntries(current);
}

describe('chains of ops steps', () => {
  const schemaOf = (ops1: readonly LensOp[], ops2: readonly LensOp[]) =>
    versioned<unknown>('lens-law').next<unknown>('first', { ops: ops1 }).next<unknown>('second', { ops: ops2 });

  it('reads v1 data as the two steps\' ops would, concatenated', () => {
    fc.assert(
      fc.property(chainCase, ({ doc, ops1, ops2 }) => {
        const read = schemaOf(ops1, ops2).read({ v: 1, payload: doc }, { context: ctx });
        expect(read.ok).toBe(true);
        if (read.ok) expect(read.value).toEqual(compileLens([...ops1, ...ops2]).up(doc, ctx));
      }),
      { numRuns: 1_000 },
    );
  });

  it('writes down to v1 and reads back the same value', () => {
    fc.assert(
      fc.property(chainCase, ({ doc, ops1, ops2 }) => {
        const schema = schemaOf(ops1, ops2);
        const current = compileLens([...ops1, ...ops2]).up(doc, ctx);
        const envelope = schema.write(current, { as: 1 });
        expect(envelope.v).toBe(1);
        expect(envelope.payload).toEqual(doc);
        const back = schema.read(envelope, { context: ctx });
        expect(back.ok).toBe(true);
        if (back.ok) expect(back.value).toEqual(current);
      }),
      { numRuns: 1_000 },
    );
  });
});
