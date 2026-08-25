import { afterEach, describe, expect, it, vi } from 'vitest';
import { BraidError } from '../errors.js';
import { BoundaryChannel, ChannelBacking, createBoundaryChannel } from './channel.js';
import { createSameRealmBackingPair } from './same-realm-backing.js';
import { createPortBacking } from './port-backing.js';
import { WEAVE_VERSION, isEnvelope, weaveId } from './envelope.js';

/**
 * Both transports are exercised by the same suite, and that is the point rather than thoroughness
 * for its own sake: the trusted tier ships on `same-realm` and the untrusted tier will ship on
 * `port`, so any behaviour that differs between them is a bug that would only appear in Phase 5,
 * inside somebody else's fragment.
 */

interface Pair {
  host: BoundaryChannel;
  fragment: BoundaryChannel;
  dispose(): void;
}

const INSTANCE = 'instance-1';

function buildPair(hostBacking: ChannelBacking, fragmentBacking: ChannelBacking): Pair {
  const host = createBoundaryChannel({ backing: hostBacking, fragmentId: 'checkout', instance: INSTANCE });
  const fragment = createBoundaryChannel({ backing: fragmentBacking, fragmentId: 'checkout', instance: INSTANCE });
  return {
    host,
    fragment,
    dispose() {
      host.close();
      fragment.close();
    },
  };
}

function sameRealmPair(): Pair {
  const backings = createSameRealmBackingPair();
  return buildPair(backings.host, backings.fragment);
}

function portPair(): Pair {
  const channel = new MessageChannel();
  return buildPair(createPortBacking(channel.port1), createPortBacking(channel.port2));
}

const transports: Array<[string, () => Pair]> = [
  ['same-realm', sameRealmPair],
  ['port', portPair],
];

describe.each(transports)('boundary channel over %s', (_name, makePair) => {
  let pair: Pair;
  afterEach(() => pair?.dispose());

  it('round-trips a request to its reply', async () => {
    pair = makePair();
    pair.fragment.on('ctx/get', (payload) => ({ echoed: payload }));

    await expect(pair.host.request('ctx/get', { key: 'cart' })).resolves.toEqual({
      echoed: { key: 'cart' },
    });
  });

  it('awaits a handler that returns a promise', async () => {
    pair = makePair();
    pair.fragment.on('slow', async () => {
      await Promise.resolve();
      return 'eventually';
    });

    await expect(pair.host.request('slow')).resolves.toBe('eventually');
  });

  it('delivers a fire-and-forget send without expecting a reply', async () => {
    pair = makePair();
    const seen = vi.fn();
    pair.fragment.on('ctx/changed', seen);

    pair.host.send('ctx/changed', { key: 'cart', value: 3 });
    await flush();

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ key: 'cart', value: 3 }, expect.objectContaining({ type: 'ctx/changed' }));
  });

  it('never dispatches synchronously, on either transport', async () => {
    pair = makePair();
    const seen = vi.fn();
    pair.fragment.on('beat', seen);

    pair.host.send('beat');
    // The assertion that keeps the two transports interchangeable: a port is async by nature, so
    // the same-realm backing must be too, or code written against it reorders when it moves.
    expect(seen).not.toHaveBeenCalled();

    await flush();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('rejects with the remote failure, preserving its stage', async () => {
    pair = makePair();
    pair.fragment.on('ctx/subscribe', () => {
      throw new BraidError('context "cart" cannot be projected down to v1', {
        fragmentId: 'checkout',
        stage: 'context-version',
        fixHint: 'add a down migration',
      });
    });

    const error = await pair.host.request('ctx/subscribe').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BraidError);
    // Relabelling this 'boundary' would point every reader at the transport instead of the cause.
    expect((error as BraidError).stage).toBe('context-version');
    expect((error as BraidError).fixHint).toBe('add a down migration');
  });

  it('rejects a request no handler claims, rather than waiting out the deadline', async () => {
    pair = makePair();

    const error = await pair.host.request('nobody/home', undefined, { timeoutMs: 10_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BraidError);
    expect((error as BraidError).stage).toBe('boundary');
    expect((error as BraidError).message).toContain('no handler for "nobody/home"');
  });

  it('rejects a request that outlives its deadline', async () => {
    pair = makePair();
    pair.fragment.on('wedged', () => new Promise(() => undefined));

    const error = await pair.host.request('wedged', undefined, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BraidError);
    expect((error as BraidError).stage).toBe('boundary');
    expect((error as BraidError).message).toContain('20ms');
  });

  it('rejects everything in flight when the channel closes', async () => {
    pair = makePair();
    pair.fragment.on('wedged', () => new Promise(() => undefined));

    const pendingRequest = pair.host.request('wedged', undefined, { timeoutMs: 10_000 }).catch((e: unknown) => e);
    await flush();
    pair.host.close();

    const error = await pendingRequest;
    expect(error).toBeInstanceOf(BraidError);
    expect((error as BraidError).message).toContain('closed before a reply arrived');
  });

  it('replaces a handler rather than double-replying', async () => {
    pair = makePair();
    const first = vi.fn(() => 'first');
    pair.fragment.on('ping', first);
    pair.fragment.on('ping', () => 'second');

    await expect(pair.host.request('ping')).resolves.toBe('second');
    expect(first).not.toHaveBeenCalled();
  });
});

describe('channel lifetime', () => {
  it('closes when the fragment instance signal aborts', () => {
    const controller = new AbortController();
    const backings = createSameRealmBackingPair();
    const channel = createBoundaryChannel({
      backing: backings.host,
      fragmentId: 'checkout',
      instance: INSTANCE,
      signal: controller.signal,
    });

    expect(channel.closed.aborted).toBe(false);
    controller.abort();
    expect(channel.closed.aborted).toBe(true);
  });

  it('refuses to send once closed', async () => {
    const backings = createSameRealmBackingPair();
    const channel = createBoundaryChannel({ backing: backings.host, fragmentId: 'checkout', instance: INSTANCE });
    channel.close();

    await expect(channel.request('anything')).rejects.toThrow(/channel is closed/);
  });
});

describe('port backing', () => {
  it('drops anything inbound that is not an envelope', async () => {
    const channel = new MessageChannel();
    const backing = createPortBacking(channel.port1);
    const seen = vi.fn();
    backing.receive(seen);

    channel.port2.postMessage({ hostile: true });
    channel.port2.postMessage('nonsense');
    channel.port2.postMessage({ v: 99, id: 'x', type: 'y', fragmentId: 'z', instance: 'i' });
    await flush();

    // Silence, not a console error: an untrusted peer must not be able to fill the host's console
    // by posting garbage in a loop.
    expect(seen).not.toHaveBeenCalled();
    backing.close();
  });

  it('names the message type when a payload cannot be cloned', () => {
    const channel = new MessageChannel();
    const backing = createPortBacking(channel.port1);

    expect(() =>
      backing.post({
        v: WEAVE_VERSION,
        id: weaveId(),
        type: 'ctx/changed',
        fragmentId: 'checkout',
        instance: INSTANCE,
        payload: { callback: () => undefined },
      }),
    ).toThrow(/"ctx\/changed" payload could not cross the boundary/);

    backing.close();
  });
});

describe('envelope', () => {
  it('accepts a well-formed envelope and rejects near-misses', () => {
    const good = { v: WEAVE_VERSION, id: 'a', type: 't', fragmentId: 'f', instance: 'i' };
    expect(isEnvelope(good)).toBe(true);
    expect(isEnvelope({ ...good, v: 2 })).toBe(false);
    expect(isEnvelope({ ...good, instance: undefined })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
  });

  it('generates distinct ids', () => {
    expect(weaveId()).not.toBe(weaveId());
  });
});

/**
 * Several macrotask turns: enough for the outbound hop, the handler, and the reply on either
 * transport.
 *
 * More than one turn because a `MessagePort` delivers on the host's task queue, and a single
 * `setTimeout(0)` is not reliably behind it when the machine is loaded — which showed up as a
 * roughly one-in-eight flake rather than as a failure anyone could reproduce on demand.
 */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}
