import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitPrerequisites, NotEntitledError, parseRequires, type PrerequisiteResolver } from './prerequisites.js';
import { setBraidConfig } from '../config.js';
import { BraidError } from '../errors.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('awaitPrerequisites()', () => {
  afterEach(() => setBraidConfig({ prerequisites: {}, prerequisiteTimeoutMs: 15_000 }));

  it('resolves when every key is ready, using exact keys before the longest matching pattern', async () => {
    const calls: string[] = [];
    const resolver = (name: string): PrerequisiteResolver => (key) => (calls.push(`${name}:${key}`), 'ready');
    setBraidConfig({ prerequisites: { 'session:*': resolver('any'), 'session:kcd*': resolver('kcd'), 'flag:on': resolver('exact') } });

    await awaitPrerequisites(['session:other', 'session:kcd-jwt', 'flag:on'], 'orders', new AbortController().signal);
    expect(calls.sort()).toEqual(['any:session:other', 'exact:flag:on', 'kcd:session:kcd-jwt']);
  });

  it('calls a resolver once for a key many fragments wait on', async () => {
    const gate = deferred<'ready'>();
    const resolver = vi.fn<PrerequisiteResolver>(() => gate.promise);
    setBraidConfig({ prerequisites: { 'session:*': resolver } });

    const waits = ['a', 'b', 'c'].map((id) => awaitPrerequisites(['session:kcd'], id, new AbortController().signal));
    gate.resolve('ready');
    await Promise.all(waits);
    expect(resolver).toHaveBeenCalledTimes(1);

    // and again on a later boot, once the first has settled
    await awaitPrerequisites(['session:kcd'], 'a', new AbortController().signal);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('reports not-entitled as its own error, distinct from a failure', async () => {
    setBraidConfig({ prerequisites: { 'group:hr': () => 'not-entitled' } });
    const error = await awaitPrerequisites(['group:hr'], 'payroll', new AbortController().signal).catch((e) => e);
    expect(error).toBeInstanceOf(NotEntitledError);
    expect(error).toMatchObject({ stage: 'prerequisite', fragmentId: 'payroll', notEntitled: true });
  });

  it('fails with a named prerequisite error for a missing resolver, a throw, a bad outcome, or a timeout', async () => {
    setBraidConfig({
      prerequisiteTimeoutMs: 20,
      prerequisites: {
        broken: () => Promise.reject(new Error('idp down')),
        odd: () => 'yes' as never,
        slow: () => new Promise(() => undefined),
      },
    });
    const signal = new AbortController().signal;
    for (const key of ['nobody-handles-this', 'broken', 'odd', 'slow']) {
      const error = await awaitPrerequisites([key], 'orders', signal).catch((e) => e);
      expect(error, key).toBeInstanceOf(BraidError);
      expect(error, key).not.toBeInstanceOf(NotEntitledError);
      expect(error.stage, key).toBe('prerequisite');
    }
  });

  it("aborts the resolver's signal once no fragment is waiting, and not before", async () => {
    let seen: AbortSignal | undefined;
    setBraidConfig({ prerequisites: { 'session:*': (_key, { signal }) => ((seen = signal), new Promise(() => undefined)) } });
    const first = new AbortController();
    const second = new AbortController();
    const waits = [first, second].map((c) => awaitPrerequisites(['session:kcd'], 'x', c.signal).catch(() => 'stopped'));
    await Promise.resolve();
    await Promise.resolve();

    first.abort();
    await waits[0];
    expect(seen?.aborted).toBe(false);
    second.abort();
    expect(await waits[1]).toBe('stopped');
    expect(seen?.aborted).toBe(true);
  });
});

describe('awaitPrerequisites() at the edges', () => {
  afterEach(() => setBraidConfig({ prerequisites: {}, prerequisiteTimeoutMs: 15_000 }));

  it('joins nothing and leaves nothing unhandled when its signal is already aborted', async () => {
    const resolver = vi.fn<PrerequisiteResolver>(() => new Promise(() => undefined));
    setBraidConfig({ prerequisites: { k: resolver } });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const aborted = AbortSignal.abort();
    await expect(awaitPrerequisites(['k'], 'x', aborted)).rejects.toBe(aborted.reason);
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(resolver).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('starts a fresh resolution for a slot that arrives after every earlier one left', async () => {
    const resolver = vi.fn<PrerequisiteResolver>(() => new Promise(() => undefined));
    setBraidConfig({ prerequisites: { k: resolver } });
    const first = new AbortController();
    const abandoned = awaitPrerequisites(['k'], 'a', first.signal).catch(() => 'left');
    await Promise.resolve();
    first.abort();
    await abandoned;

    setBraidConfig({ prerequisites: { k: vi.fn<PrerequisiteResolver>(() => 'ready') } });
    await expect(awaitPrerequisites(['k'], 'b', new AbortController().signal)).resolves.toBeUndefined();
  });

  it("does not abort a resolver's signal after it has answered", async () => {
    let seen: AbortSignal | undefined;
    setBraidConfig({ prerequisiteTimeoutMs: 20, prerequisites: { k: (_key, { signal }) => ((seen = signal), 'ready') } });
    await awaitPrerequisites(['k'], 'x', new AbortController().signal);
    await new Promise((r) => setTimeout(r, 40));
    expect(seen?.aborted).toBe(false);
  });

  it('stops waiting on the other keys once one is not entitled', async () => {
    let sessionSignal: AbortSignal | undefined;
    setBraidConfig({
      prerequisites: {
        'group:hr': () => 'not-entitled',
        'session:*': (_key, { signal }) => ((sessionSignal = signal), new Promise(() => undefined)),
      },
    });
    await expect(awaitPrerequisites(['session:hr', 'group:hr'], 'payroll', new AbortController().signal)).rejects.toBeInstanceOf(
      NotEntitledError,
    );
    expect(sessionSignal?.aborted).toBe(true);
  });

  it("names a resolver's own TimeoutError a failure, not the prerequisite timeout", async () => {
    setBraidConfig({ prerequisites: { k: () => Promise.reject(new DOMException('upstream', 'TimeoutError')) } });
    const error = await awaitPrerequisites(['k'], 'x', new AbortController().signal).catch((e) => e);
    expect(error.message).toContain('the prerequisite "k" failed');
    expect(error.message).not.toContain('did not resolve');
  });
});

describe('parseRequires()', () => {
  it('reads an attribute or a manifest list, dropping blanks and duplicates', () => {
    expect(parseRequires(' session:a  flag:b session:a ')).toEqual(['session:a', 'flag:b']);
    expect(parseRequires(['session:a', '', 3, 'session:a'])).toEqual(['session:a']);
    expect(parseRequires(undefined)).toEqual([]);
  });
});
