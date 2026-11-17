import { describe, expect, it } from 'vitest';
import { MigrationContext } from './context.js';
import { LensOp, compileLens } from './lens.js';
import { versioned } from './versioned.js';

const ctx: MigrationContext = { now: () => new Date('2026-08-10T12:00:00.000Z') };

describe('compileLens — individual ops', () => {
  it('rename moves a value and inverts to the opposite move', () => {
    const lens = compileLens([{ rename: { from: 'currency', to: 'baseCurrency' } }]);

    expect(lens.up({ currency: 'USD' }, ctx)).toEqual({ baseCurrency: 'USD' });
    expect(lens.down?.({ baseCurrency: 'USD' }, ctx)).toEqual({ currency: 'USD' });
  });

  it('move handles deep dot-paths, creating intermediate objects', () => {
    const lens = compileLens([{ move: { from: 'cashPct', to: 'liquidity.cashPct' } }]);

    expect(lens.up({ cashPct: 4 }, ctx)).toEqual({ liquidity: { cashPct: 4 } });
    // The emptied intermediate object is pruned — v1 never had `liquidity`.
    expect(lens.down?.({ liquidity: { cashPct: 4 } }, ctx)).toEqual({ cashPct: 4 });
  });

  it('wrap promotes a scalar into structure; down unwraps and reports the loss', () => {
    const lens = compileLens([{ wrap: { path: 'nav', key: 'amount', also: { asOf: { $now: true } } } }]);

    expect(lens.up({ nav: 100 }, ctx)).toEqual({
      nav: { amount: 100, asOf: '2026-08-10T12:00:00.000Z' },
    });
    expect(lens.derivedUp).toEqual(['nav.asOf']);
    expect(lens.lossyDown).toEqual(['nav.asOf']);
    expect(lens.down?.({ nav: { amount: 100, asOf: 'whenever' } }, ctx)).toEqual({ nav: 100 });
  });

  it('wrap `$from` copies real data and is not marked derived', () => {
    const lens = compileLens([
      { wrap: { path: 'marketValue', key: 'amount', also: { currency: { $from: 'currency' } } } },
    ]);

    expect(lens.up({ marketValue: 5, currency: 'EUR' }, ctx)).toEqual({
      marketValue: { amount: 5, currency: 'EUR' },
      currency: 'EUR',
    });
    expect(lens.derivedUp).toEqual([]);
  });

  it('hoist extracts a member; down re-wraps it', () => {
    const lens = compileLens([{ hoist: { path: 'author', key: 'name' } }]);

    expect(lens.up({ author: { name: 'Rev. Miller', email: 'x@y' } }, ctx)).toEqual({ author: 'Rev. Miller' });
    expect(lens.down?.({ author: 'Rev. Miller' }, ctx)).toEqual({ author: { name: 'Rev. Miller' } });
  });

  it('default fills only when absent, and is a guess by definition', () => {
    const lens = compileLens([{ default: { path: 'liquidity.hqlaPct', value: 0 } }]);

    expect(lens.up({}, ctx)).toEqual({ liquidity: { hqlaPct: 0 } });
    expect(lens.up({ liquidity: { hqlaPct: 9 } }, ctx)).toEqual({ liquidity: { hqlaPct: 9 } });
    expect(lens.derivedUp).toEqual(['liquidity.hqlaPct']);
    expect(lens.lossyDown).toEqual(['liquidity.hqlaPct']);
  });

  it('drop without restore cannot travel down', () => {
    const lens = compileLens([{ drop: { path: 'legacyFlag' } }]);

    expect(lens.up({ legacyFlag: true, keep: 1 }, ctx)).toEqual({ keep: 1 });
    expect(lens.invertible).toBe(false);
    expect(lens.down).toBeNull();
  });

  it('drop with restore reinstates the field going down, marked as a guess', () => {
    const lens = compileLens([{ drop: { path: 'legacyFlag', restore: false } }]);

    expect(lens.down?.({ keep: 1 }, ctx)).toEqual({ keep: 1, legacyFlag: false });
    expect(lens.derivedDown).toEqual(['legacyFlag']);
  });

  it('convert coerces both ways', () => {
    const lens = compileLens([{ convert: { path: 'qty', to: 'string' } }]);

    expect(lens.up({ qty: 7 }, ctx)).toEqual({ qty: '7' });
    expect(lens.down?.({ qty: '7' }, ctx)).toEqual({ qty: 7 });
  });

  it('convert via an explicit table inverts when bijective', () => {
    const lens = compileLens([
      { convert: { path: 'tier', to: 'string', via: { '1': 'T1', '2': 'T2' } } },
    ]);

    expect(lens.up({ tier: 1 }, ctx)).toEqual({ tier: 'T1' });
    expect(lens.down?.({ tier: 'T2' }, ctx)).toEqual({ tier: 2 });
  });

  it('convert via a non-bijective table refuses the down direction', () => {
    const lens = compileLens([
      { convert: { path: 'tier', to: 'string', via: { '1': 'T1', '2': 'T1' } } },
    ]);
    expect(lens.invertible).toBe(false);
  });

  it('map applies sub-ops per element and prefixes provenance with the array path', () => {
    const lens = compileLens([
      {
        map: {
          path: 'holdings',
          ops: [
            { wrap: { path: 'marketValue', key: 'amount', also: { currency: { $from: '/baseCurrency' } } } },
            { default: { path: 'liquidityTier', value: 'T2' } },
          ],
        },
      },
    ]);

    const result = lens.up(
      { baseCurrency: 'USD', holdings: [{ marketValue: 10 }, { marketValue: 20 }] },
      ctx,
    ) as { holdings: unknown[] };

    expect(result.holdings).toEqual([
      { marketValue: { amount: 10, currency: 'USD' }, liquidityTier: 'T2' },
      { marketValue: { amount: 20, currency: 'USD' }, liquidityTier: 'T2' },
    ]);
    expect(lens.derivedUp).toEqual(['holdings[].liquidityTier']);
    expect(lens.lossyDown).toEqual(['holdings[].marketValue.currency', 'holdings[].liquidityTier']);
  });

  it('const overwrites unconditionally', () => {
    const lens = compileLens([{ const: { path: 'schemaHint', value: 'x', derived: true } }]);
    expect(lens.up({ schemaHint: 'old' }, ctx)).toEqual({ schemaHint: 'x' });
    expect(lens.derivedUp).toEqual(['schemaHint']);
  });

  it('rejects malformed ops at compile time, not read time', () => {
    expect(() => compileLens([{ bogus: {} } as never])).toThrow(TypeError);
    expect(() => compileLens([{ rename: { from: '', to: 'x' } } as never])).toThrow(TypeError);
  });

  it('never mutates its input', () => {
    const input = { currency: 'USD', holdings: [{ marketValue: 1 }] };
    const snapshot = structuredClone(input);
    compileLens([{ rename: { from: 'currency', to: 'baseCurrency' } }]).up(input, ctx);
    expect(input).toEqual(snapshot);
  });
});

describe('compileLens — round trips', () => {
  const fundOps: LensOp[] = [
    { rename: { from: 'currency', to: 'baseCurrency' } },
    { wrap: { path: 'nav', key: 'amount', also: { asOf: { $now: true } } } },
    { move: { from: 'cashPct', to: 'liquidity.cashPct' } },
    { default: { path: 'liquidity.hqlaPct', value: 0 } },
    {
      map: {
        path: 'holdings',
        ops: [
          { wrap: { path: 'marketValue', key: 'amount', also: { currency: { $from: '/baseCurrency' } } } },
          { default: { path: 'liquidityTier', value: 'T2' } },
        ],
      },
    },
  ];

  const v1 = {
    id: 'f1',
    currency: 'USD',
    nav: 100,
    cashPct: 4,
    holdings: [{ ticker: 'TBILL-3M', marketValue: 40 }],
  };

  it('down(up(x)) restores the original modulo empty containers', () => {
    const lens = compileLens(fundOps);
    const roundTripped = lens.down?.(lens.up(v1, ctx), ctx) as Record<string, unknown>;

    expect(roundTripped['id']).toBe('f1');
    expect(roundTripped['currency']).toBe('USD');
    expect(roundTripped['nav']).toBe(100);
    expect(roundTripped['cashPct']).toBe(4);
    expect(roundTripped['holdings']).toEqual([{ ticker: 'TBILL-3M', marketValue: 40 }]);
  });

  it('up(down(y)) restores defaults deterministically under a pinned clock', () => {
    const lens = compileLens(fundOps);
    const v2 = lens.up(v1, ctx);
    const again = lens.up(lens.down?.(v2, ctx), ctx);
    expect(again).toEqual(v2);
  });
});

describe('ops-authored chain steps', () => {
  it('a schema step declared as ops gets up, down, and provenance computed', () => {
    interface V1 { id: string; currency: string }
    interface V2 { id: string; baseCurrency: string; hqlaPct: number }

    const schema = versioned<V1>('ops-fund').next<V2>('rename currency; add hqlaPct', {
      ops: [
        { rename: { from: 'currency', to: 'baseCurrency' } },
        { default: { path: 'hqlaPct', value: 0 } },
      ],
    });

    const up = schema.read({ v: 1, payload: { id: 'a', currency: 'USD' } });
    expect(up.ok).toBe(true);
    if (up.ok) {
      expect(up.value).toEqual({ id: 'a', baseCurrency: 'USD', hqlaPct: 0 });
      expect(up.derivedPaths).toEqual(['hqlaPct']);
    }

    const downWritten = schema.write({ id: 'a', baseCurrency: 'EUR', hqlaPct: 5 }, { as: 1 });
    expect(downWritten.payload).toEqual({ id: 'a', currency: 'EUR' });
  });
});

describe('compileLens — paths and keys from untrusted documents', () => {
  const ctx = { now: () => new Date('2026-01-01T00:00:00Z') };

  it.each([
    [{ rename: { from: 'title', to: '__proto__.polluted' } }],
    [{ move: { from: 'constructor.prototype.x', to: 'y' } }],
    [{ default: { path: 'a.prototype.b', value: 1 } }],
    [{ const: { path: '__proto__', value: {} } }],
    [{ drop: { path: 'x.__proto__' } }],
    [{ map: { path: 'items', ops: [{ default: { path: '__proto__.y', value: 1 } }] } }],
    [{ wrap: { path: 'price', key: '__proto__' } }],
    [{ wrap: { path: 'price', key: 'amount', also: { constructor: 1 } } }],
    [{ wrap: { path: 'price', key: 'amount', also: { at: { $from: '__proto__.x' } } } }],
    [{ hoist: { path: 'image', key: 'prototype' } }],
  ] as const)('refuses %j at compile time', (op) => {
    expect(() => compileLens([op as never])).toThrow(TypeError);
  });

  it('never writes to Object.prototype, whatever the payload holds', () => {
    const lens = compileLens([{ convert: { path: 'size', to: 'number', via: { small: 1, large: 2 } } }, { default: { path: 'size.unit', value: 'PWNED' } }]);
    // "__proto__" is not a key of the table, so it has no mapping — it does not map to
    // Object.prototype for the next op to write into.
    expect(() => lens.up({ size: '__proto__' }, ctx)).toThrow('no mapping');
    expect(({} as Record<string, unknown>)['unit']).toBeUndefined();
  });

  it('treats a value that names an inherited member as unmapped, not as the member', () => {
    const lens = compileLens([{ convert: { path: 'size', to: 'number', via: { small: 1 } } }]);
    expect(() => lens.up({ size: 'constructor' }, ctx)).toThrow('no mapping');
    expect(() => lens.up({ size: 'toString' }, ctx)).toThrow('no mapping');
  });

  it('reads own properties only', () => {
    const lens = compileLens([{ rename: { from: 'toString', to: 'label' } }]);
    expect(lens.up({ other: 1 }, ctx)).toEqual({ other: 1 });
    expect(lens.up({ toString: 'mine' }, ctx)).toEqual({ label: 'mine' });
  });
});
