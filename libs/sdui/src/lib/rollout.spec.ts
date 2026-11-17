import {
  type RolloutPlan,
  assignRollout,
  bucketOf,
  evaluateFlags,
  inPercent,
  rolloutPercent,
} from '../index.js';

const installs = Array.from(
  { length: 100_000 },
  (_, index) => `ins_${index.toString(36)}`,
);
const plan = (
  stage: number,
  extra: Partial<RolloutPlan> = {},
): RolloutPlan => ({
  stable: 'rel_a',
  candidate: 'rel_b',
  stages: [1, 5, 25, 50, 100],
  stage,
  salt: 'rollout-1',
  ...extra,
});

describe('rollout bucketing over 100,000 installs', () => {
  const at5 = installs.map((install) => assignRollout(plan(1), install).arm);
  const at25 = installs.map((install) => assignRollout(plan(2), install).arm);

  it('puts 5% ± 0.3% on the candidate at the 5% stage', () => {
    const share =
      at5.filter((arm) => arm === 'candidate').length / installs.length;
    expect(share).toBeGreaterThan(0.047);
    expect(share).toBeLessThan(0.053);
  });

  it('gives the same install the same answer on every call', () => {
    expect(
      installs.map((install) => assignRollout(plan(1), install).arm),
    ).toEqual(at5);
  });

  it('moves no install from candidate back to stable when 5% widens to 25%', () => {
    const movedBack = installs.filter(
      (_, index) => at5[index] === 'candidate' && at25[index] === 'stable',
    );
    expect(movedBack).toEqual([]);
    const share =
      at25.filter((arm) => arm === 'candidate').length / installs.length;
    expect(share).toBeGreaterThan(0.245);
    expect(share).toBeLessThan(0.255);
  });

  it('spreads buckets evenly, and differently per salt', () => {
    const deciles = new Array(10).fill(0);
    for (const install of installs)
      deciles[Math.floor(bucketOf('rollout-1', install) / 1000)]++;
    for (const count of deciles)
      expect(Math.abs(count - 10_000)).toBeLessThan(500);
    const sameBucket = installs
      .slice(0, 5000)
      .filter(
        (install) =>
          bucketOf('rollout-1', install) === bucketOf('rollout-2', install),
      );
    expect(sameBucket.length).toBeLessThan(10);
  });
});

describe('rollout plans', () => {
  it('reaches everyone at 100% and no one when halted', () => {
    expect(
      installs
        .slice(0, 2000)
        .every(
          (install) => assignRollout(plan(4), install).arm === 'candidate',
        ),
    ).toBe(true);
    expect(
      installs
        .slice(0, 2000)
        .every(
          (install) =>
            assignRollout(plan(4, { halted: true }), install).release ===
            'rel_a',
        ),
    ).toBe(true);
    expect(rolloutPercent(plan(2))).toBe(25);
    expect(rolloutPercent(plan(9))).toBe(100);
    expect(rolloutPercent(plan(2, { halted: true }))).toBe(0);
  });

  it('keeps ineligible installs on stable whatever their bucket', () => {
    const android = plan(4, { audience: { platform: ['android'] } });
    expect(assignRollout(android, 'ins_1', { platform: 'ios' }).arm).toBe(
      'stable',
    );
    expect(assignRollout(android, 'ins_1', { platform: 'android' }).arm).toBe(
      'candidate',
    );
  });

  it('treats percentages at their edges exactly', () => {
    expect(inPercent(0, 0)).toBe(false);
    expect(inPercent(0, 0.01)).toBe(true);
    expect(inPercent(1, 0.01)).toBe(false);
    expect(inPercent(9999, 100)).toBe(true);
    expect(inPercent(9999, 250)).toBe(true);
    expect(inPercent(0, -5)).toBe(false);
  });
});

describe('evaluateFlags', () => {
  it('serves the default when off, when no rule matches, and for a flag with no rules', () => {
    const { values, assignments } = evaluateFlags(
      [
        { key: 'off', default: 'd', off: true, rules: [{ value: 'r' }] },
        {
          key: 'nobody',
          default: false,
          rules: [{ when: { audience: 'staff' }, value: true }],
        },
        { key: 'bare', default: 3 },
      ],
      'ins_1',
    );
    expect(values).toEqual({ off: 'd', nobody: false, bare: 3 });
    expect(assignments).toEqual([]);
  });

  it('takes the first matching rule and records which', () => {
    const definitions = [
      {
        key: 'layout',
        default: 'a',
        rules: [{ when: { audience: 'staff' }, value: 'c' }, { value: 'b' }],
      },
    ];
    expect(
      evaluateFlags(definitions, 'ins_1', { audiences: ['staff'] }),
    ).toEqual({ values: { layout: 'c' }, assignments: ['layout:0'] });
    expect(evaluateFlags(definitions, 'ins_1')).toEqual({
      values: { layout: 'b' },
      assignments: ['layout:1'],
    });
  });

  it('does not let a rule read another flag', () => {
    const definitions = [
      { key: 'a', default: false, rules: [{ value: true }] },
      {
        key: 'b',
        default: false,
        rules: [{ when: { flag: 'a' }, value: true }],
      },
    ];
    expect(
      evaluateFlags(definitions, 'ins_1', { flags: { a: true } }).values,
    ).toEqual({ a: true, b: false });
  });

  it('holds a percentage to its share and keeps it sticky', () => {
    const definitions = [
      {
        key: 'new-search',
        default: false,
        rules: [{ percent: 5, value: true }],
      },
    ];
    const on = installs
      .slice(0, 40_000)
      .filter(
        (install) =>
          evaluateFlags(definitions, install).values['new-search'] === true,
      );
    expect(on.length / 40_000).toBeGreaterThan(0.045);
    expect(on.length / 40_000).toBeLessThan(0.055);
    expect(
      on
        .slice(0, 200)
        .every(
          (install) =>
            evaluateFlags(definitions, install).values['new-search'] === true,
        ),
    ).toBe(true);
  });
});
