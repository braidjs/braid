import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initBraid } from '../index.js';
import { getBraidConfig } from '../config.js';
import { createRecovery, RecoveryEvent, RecoveryPolicy } from './recovery.js';

describe('createRecovery()', () => {
  let policy: RecoveryPolicy | undefined;
  let announced: RecoveryEvent[];
  let reboot: ReturnType<typeof vi.fn>;
  const recovery = () => createRecovery({ policy: () => policy, announce: (event) => announced.push(event), reboot });

  beforeEach(() => {
    vi.useFakeTimers();
    policy = { attempts: 3, delayMs: 1_000 };
    announced = [];
    reboot = vi.fn();
  });
  afterEach(() => vi.useRealTimers());

  it('reboots after 1s, 4s and 16s, then gives up', () => {
    const subject = recovery();
    for (const expected of [1_000, 4_000, 16_000]) {
      subject.onError('fragment-fetch', false);
      expect(announced.at(-1)!.delayMs).toBe(expected);
      vi.advanceTimersByTime(expected - 1);
      const before = reboot.mock.calls.length;
      vi.advanceTimersByTime(1);
      expect(reboot).toHaveBeenCalledTimes(before + 1);
    }
    subject.onError('fragment-fetch', false);
    vi.advanceTimersByTime(100_000);
    expect(reboot).toHaveBeenCalledTimes(3);
    expect(announced.map((event) => event.attempt)).toEqual([1, 2, 3]);
  });

  it('reboots a fragment that went gone', () => {
    recovery().onGone();
    vi.advanceTimersByTime(1_000);
    expect(reboot).toHaveBeenCalledOnce();
    expect(announced[0].reason).toBe('gone');
  });

  it.each(['slot-config', 'adapter-resolution', 'contract', 'context-version', 'prerequisite', 'teardown'] as const)(
    'never retries %s, which fails the same way every time',
    (stage) => {
      recovery().onError(stage, false);
      vi.advanceTimersByTime(100_000);
      expect(reboot).not.toHaveBeenCalled();
    },
  );

  it('never retries a user who is not entitled', () => {
    recovery().onError('fragment-fetch', true);
    vi.advanceTimersByTime(100_000);
    expect(reboot).not.toHaveBeenCalled();
  });

  it('does nothing when the host did not opt in', () => {
    policy = undefined;
    const subject = recovery();
    subject.onError('realm-boot', false);
    subject.onGone();
    vi.advanceTimersByTime(100_000);
    expect(reboot).not.toHaveBeenCalled();
  });

  it('schedules one reboot at a time', () => {
    const subject = recovery();
    subject.onError('realm-boot', false);
    subject.onGone();
    vi.advanceTimersByTime(1_000);
    expect(reboot).toHaveBeenCalledOnce();
    expect(announced).toHaveLength(1);
  });

  it('cancels a pending reboot and restores the budget on reset', () => {
    const subject = recovery();
    subject.onError('realm-boot', false);
    subject.reset();
    vi.advanceTimersByTime(100_000);
    expect(reboot).not.toHaveBeenCalled();
    subject.onError('realm-boot', false);
    expect(announced.at(-1)).toMatchObject({ attempt: 1, delayMs: 1_000 });
  });
});

describe('initBraid({ recover })', () => {
  afterEach(() => initBraid({ recover: false }));

  it('takes the defaults from true, accepts its own, and turns off with false', () => {
    initBraid({ recover: true });
    expect(getBraidConfig().recover).toEqual({ attempts: 3, delayMs: 1_000 });
    initBraid({ recover: { attempts: 5, delayMs: 200 } });
    expect(getBraidConfig().recover).toEqual({ attempts: 5, delayMs: 200 });
    initBraid({ recover: false });
    expect(getBraidConfig().recover).toBeUndefined();
  });

  it('refuses a nonsense policy', () => {
    expect(() => initBraid({ recover: { attempts: 0 } })).toThrow(/recover/);
    expect(() => initBraid({ recover: { delayMs: -1 } })).toThrow(/recover/);
  });
});
