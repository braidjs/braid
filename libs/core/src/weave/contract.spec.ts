import { versioned } from '@braidlabs/skew';
import type { VersionedSchema } from '@braidlabs/skew';
import { describe, expect, it } from 'vitest';
import { negotiateContract, satisfiesRange } from './contract.js';

interface V1 { ticker: string }
interface V2 extends V1 { market: string }
interface V3 extends V2 { currency: string }

/** Two down-migrations, each discarding the field its step introduced. */
const Instrument = versioned<V1>('spec.instrument')
  .next<V2>('carry the MIC market identifier', {
    up: (v1) => ({ ...v1, market: '' }),
    down: ({ market: _market, ...rest }) => rest,
    lossy: ['market'],
  })
  .next<V3>('carry the settlement currency', {
    up: (v2) => ({ ...v2, currency: 'USD' }),
    down: ({ currency: _currency, ...rest }) => rest,
    lossy: ['currency'],
  });

/** The same shape with no way back — a gap that cannot be bridged. */
const OneWay = versioned<V1>('spec.one-way').next<V2>('add market, no inverse', (v1) => ({ ...v1, market: '' }));

const schemas = (entries: Record<string, VersionedSchema<unknown>>) => (key: string) => entries[key];

describe('satisfiesRange()', () => {
  it.each([
    ['1.4.0', '>=1.4.0', true],
    ['1.5.2', '>=1.4.0', true],
    ['1.3.9', '>=1.4.0', false],
    ['2.0.0', '^1.4.0', false],
    ['1.9.9', '^1.4.0', true],
    ['1.4.9', '~1.4.0', true],
    ['1.5.0', '~1.4.0', false],
    ['1.4.0', '1.4.0', true],
    ['1.4.1', '1.4.0', false],
    ['1.9.0', '1.x', true],
    ['2.0.0', '1.x', false],
    ['0.3.0', '*', true],
    ['0.9.0', '^0.9.1', false],
    ['0.9.2', '^0.9.1', true],
    ['0.10.0', '^0.9.1', false],
  ])('%s satisfies %s → %s', (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });

  it.each(['1.2.3 - 2.0.0', '>=1.0.0 || <2.0.0', 'latest', ''.padEnd(3, 'x')])(
    'reports %s as unparseable rather than guessing',
    (range) => {
      expect(satisfiesRange('1.4.0', range)).toBe('unparseable');
    },
  );
});

describe('negotiateContract()', () => {
  it('accepts a fragment that declares no contract at all', () => {
    // compat's promise is that being composed requires no app change; a negotiation that refused
    // undeclared fragments would revoke it.
    const result = negotiateContract({ host: { version: '1.0.0' }, fragment: undefined, schemaFor: schemas({}) });
    expect(result.outcome).toBe('compatible');
  });

  it('accepts when the host satisfies the required range', () => {
    const result = negotiateContract({
      host: { version: '1.4.2' },
      fragment: { version: '2.1.0', requires: { host: '>=1.4.0' } },
      schemaFor: schemas({}),
    });
    expect(result.outcome).toBe('compatible');
  });

  it('refuses when the host is too old, naming both versions', () => {
    const result = negotiateContract({
      host: { version: '1.2.0' },
      fragment: { version: '2.1.0', requires: { host: '>=1.4.0' } },
      schemaFor: schemas({}),
    });

    expect(result.outcome).toBe('incompatible');
    expect(result.reason).toContain('>=1.4.0');
    expect(result.reason).toContain('1.2.0');
  });

  it('refuses when the host declares no contract but the fragment requires one', () => {
    const result = negotiateContract({
      host: undefined,
      fragment: { version: '2.1.0', requires: { host: '>=1.4.0' } },
      schemaFor: schemas({}),
    });

    expect(result.outcome).toBe('incompatible');
    expect(result.fixHint).toContain('initBraid');
  });

  it('refuses a range it cannot read, rather than waving it through', () => {
    // A range nobody can parse is a requirement nobody is checking.
    const result = negotiateContract({
      host: { version: '1.4.0' },
      fragment: { version: '2.1.0', requires: { host: '>=1.0.0 || <2.0.0' } },
      schemaFor: schemas({}),
    });

    expect(result.outcome).toBe('incompatible');
    expect(result.reason).toContain('not a range this build understands');
  });

  it('bridges a context gap and reports what it discards', () => {
    const result = negotiateContract({
      host: { version: '1.4.0' },
      fragment: { version: '2.1.0', requires: { context: { instrument: 1 } } },
      schemaFor: schemas({ instrument: Instrument as VersionedSchema<unknown> }),
    });

    // The outcome only Braid offers: detecting the skew *and* saying what reconciling it costs.
    expect(result.outcome).toBe('bridged');
    expect(result.bridges).toEqual([
      { key: 'instrument', from: 3, to: 1, discards: ['market', 'currency'] },
    ]);
  });

  it('calls a same-version context compatible, not bridged', () => {
    const result = negotiateContract({
      host: { version: '1.4.0' },
      fragment: { version: '2.1.0', requires: { context: { instrument: 3 } } },
      schemaFor: schemas({ instrument: Instrument as VersionedSchema<unknown> }),
    });
    expect(result.outcome).toBe('compatible');
    expect(result.bridges).toEqual([]);
  });

  it('refuses a gap with no down migration', () => {
    const result = negotiateContract({
      host: { version: '1.4.0' },
      fragment: { version: '2.1.0', requires: { context: { instrument: 1 } } },
      schemaFor: schemas({ instrument: OneWay as VersionedSchema<unknown> }),
    });

    expect(result.outcome).toBe('incompatible');
    expect(result.reason).toContain('no down migration');
  });

  it('refuses a fragment that is newer than the host', () => {
    const result = negotiateContract({
      host: { version: '1.4.0' },
      fragment: { version: '2.1.0', requires: { context: { instrument: 9 } } },
      schemaFor: schemas({ instrument: Instrument as VersionedSchema<unknown> }),
    });

    expect(result.outcome).toBe('incompatible');
    expect(result.fixHint).toContain('deploy the host');
  });

  it('ignores a context key with no registered schema', () => {
    // An untyped context has always crossed as published; requiring a version of it changes nothing.
    const result = negotiateContract({
      host: { version: '1.4.0' },
      fragment: { version: '2.1.0', requires: { context: { untyped: 1 } } },
      schemaFor: schemas({}),
    });
    expect(result.outcome).toBe('compatible');
  });
});
