import { describe, expect, it, vi } from 'vitest';
import { BraidError } from '../errors.js';
import { createBoundaryChannel } from './channel.js';
import { createPortBacking } from './port-backing.js';
import { createSameRealmBackingPair } from './same-realm-backing.js';
import { weaveId } from './envelope.js';
import { HELLO, answerHandshake, performHostHandshake, resolveContextVersions } from './handshake.js';

const INSTANCE = 'instance-1';

function channels(kind: 'same-realm' | 'port') {
  const signal = new AbortController().signal;
  if (kind === 'port') {
    const channel = new MessageChannel();
    return {
      host: createBoundaryChannel({ backing: createPortBacking(channel.port1), fragmentId: 'checkout', instance: INSTANCE, signal }),
      fragment: createBoundaryChannel({ backing: createPortBacking(channel.port2), fragmentId: 'checkout', instance: INSTANCE, signal }),
    };
  }
  const backings = createSameRealmBackingPair();
  return {
    host: createBoundaryChannel({ backing: backings.host, fragmentId: 'checkout', instance: INSTANCE, signal }),
    fragment: createBoundaryChannel({ backing: backings.fragment, fragmentId: 'checkout', instance: INSTANCE, signal }),
  };
}

describe.each(['same-realm', 'port'] as const)('handshake over %s', (kind) => {
  it('agrees terms and delivers the opening state', async () => {
    const { host, fragment } = channels(kind);
    const opened = answerHandshake({ channel: fragment, contextVersions: { cart: 2 }, onOpen: () => undefined });

    const result = await performHostHandshake({
      channel: host,
      fragmentId: 'checkout',
      instance: weaveId(),
      assertReachable: () => undefined,
      openWith: (versions) => ({ context: { cart: { items: versions['cart'] } }, props: { sku: 'A1' } }),
    });

    expect(result.contextVersions).toEqual({ cart: 2 });

    /**
     * The host's promise settles when OPEN is *sent*, not when it lands — OPEN carries state, not
     * a question, so there is nothing to wait for on that side. Readiness is the fragment's own
     * promise, which is what `<fragment-slot>` awaits before mounting an adapter. (Making the host
     * wait for an ACK here is Phase 2's job to do properly, via liveness, rather than by blocking
     * the mount on a message whose absence and whose slowness look identical.)
     */
    await expect(opened).resolves.toEqual({ context: { cart: { items: 2 } }, props: { sku: 'A1' } });

    host.close();
    fragment.close();
  });
});

describe('handshake terms', () => {
  it('refuses a fragment speaking a different weave version', async () => {
    const { host, fragment } = channels('same-realm');
    // A fragment from a different major of @braidlabs/core: it answers, but not in this dialect.
    fragment.on(HELLO, () => ({ weave: 99 }));

    const error = await performHostHandshake({
      channel: host,
      fragmentId: 'checkout',
      instance: weaveId(),
      assertReachable: () => undefined,
      openWith: () => ({ context: {}, props: {} }),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BraidError);
    expect((error as BraidError).stage).toBe('handshake');
    expect((error as BraidError).message).toContain('v99');

    host.close();
    fragment.close();
  });

  it('fails with a named error when the fragment never answers HELLO', async () => {
    const { host, fragment } = channels('same-realm');
    // No handler registered: the realm booted but its entry module never ran.
    const error = await performHostHandshake({
      channel: host,
      fragmentId: 'checkout',
      instance: weaveId(),
      timeoutMs: 20,
      assertReachable: () => undefined,
      openWith: () => ({ context: {}, props: {} }),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BraidError);
    expect((error as BraidError).stage).toBe('boundary');

    host.close();
    fragment.close();
  });

  it('does not send OPEN when the versions are unreachable', async () => {
    const { host, fragment } = channels('same-realm');
    const onOpen = vi.fn();
    answerHandshake({ channel: fragment, contextVersions: { instrument: 1 }, onOpen });

    await performHostHandshake({
      channel: host,
      fragmentId: 'checkout',
      instance: weaveId(),
      assertReachable: () => {
        throw new BraidError('unreachable', { fragmentId: 'checkout', stage: 'context-version' });
      },
      openWith: () => ({ context: {}, props: {} }),
    }).catch(() => undefined);

    // A fragment refused at the handshake must never have been handed state.
    expect(onOpen).not.toHaveBeenCalled();

    host.close();
    fragment.close();
  });
});

describe('resolveContextVersions()', () => {
  it('lets the registry override what a fragment claims about itself', () => {
    // On the untrusted tier the fragment's half is attacker-controlled: a fragment that could name
    // its own context version could ask to be served a shape the host never intended to project.
    expect(resolveContextVersions({ cart: 9 }, { cart: 2 })).toEqual({ cart: 2 });
  });

  it('keeps declarations the registry has no opinion on', () => {
    expect(resolveContextVersions({ cart: 2, promo: 1 }, { cart: 3 })).toEqual({ cart: 3, promo: 1 });
  });

  it('handles either side being absent', () => {
    expect(resolveContextVersions(undefined, { cart: 2 })).toEqual({ cart: 2 });
    expect(resolveContextVersions({ cart: 2 }, undefined)).toEqual({ cart: 2 });
    expect(resolveContextVersions(undefined, undefined)).toEqual({});
  });
});

describe('contract negotiation in the handshake', () => {
  it('refuses an incompatible fragment before any state crosses', async () => {
    const { host, fragment } = channels('same-realm');
    const onOpen = vi.fn();
    answerHandshake({
      channel: fragment,
      contract: { version: '2.1.0', requires: { host: '>=1.4.0' } },
      onOpen,
    });

    const error = await performHostHandshake({
      channel: host,
      fragmentId: 'checkout',
      instance: weaveId(),
      hostContract: { version: '1.2.0' },
      negotiate: () => ({
        outcome: 'incompatible' as const,
        bridges: [],
        reason: 'the fragment requires host ">=1.4.0", and this host is "1.2.0"',
        fixHint: 'deploy a host that satisfies the range',
      }),
      assertReachable: () => undefined,
      openWith: () => ({ context: { cart: {} }, props: {} }),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BraidError);
    expect((error as BraidError).stage).toBe('contract');
    expect((error as BraidError).message).toContain('1.2.0');

    // Refused at mount means refused before the fragment was handed anything to render from.
    expect(onOpen).not.toHaveBeenCalled();

    host.close();
    fragment.close();
  });

  it('opens a bridged connection and reports what it costs', async () => {
    const { host, fragment } = channels('same-realm');
    const opened = answerHandshake({ channel: fragment, onOpen: () => undefined });
    const onBridged = vi.fn();

    const result = await performHostHandshake({
      channel: host,
      fragmentId: 'checkout',
      instance: weaveId(),
      negotiate: () => ({
        outcome: 'bridged' as const,
        bridges: [{ key: 'instrument', from: 3, to: 1, discards: ['market'] }],
      }),
      onBridged,
      assertReachable: () => undefined,
      openWith: () => ({ context: {}, props: {} }),
    });

    // A bridged connection is a working one — it opens — but the cost is announced, because a
    // screen rendered confidently without a discarded field still looks correct.
    await expect(opened).resolves.toBeTruthy();
    expect(result.bridges).toEqual([{ key: 'instrument', from: 3, to: 1, discards: ['market'] }]);
    expect(onBridged).toHaveBeenCalledWith([{ key: 'instrument', from: 3, to: 1, discards: ['market'] }]);

    host.close();
    fragment.close();
  });

  it('prefers the registry manifest over what the fragment claims about itself', async () => {
    const { host, fragment } = channels('same-realm');
    answerHandshake({
      channel: fragment,
      contract: { version: '9.9.9', requires: { host: '*' } },
      onOpen: () => undefined,
    });
    const negotiate = vi.fn(() => ({ outcome: 'compatible' as const, bridges: [] }));

    await performHostHandshake({
      channel: host,
      fragmentId: 'checkout',
      instance: weaveId(),
      manifestContract: { version: '2.1.0', requires: { host: '>=1.4.0' } },
      negotiate,
      assertReachable: () => undefined,
      openWith: () => ({ context: {}, props: {} }),
    });

    // On the untrusted tier this half is attacker-controlled: a fragment that could state its own
    // requirements could state them away.
    expect(negotiate).toHaveBeenCalledWith(undefined, { version: '2.1.0', requires: { host: '>=1.4.0' } });

    host.close();
    fragment.close();
  });

  it('leaves an undeclared fragment compatible', async () => {
    const { host, fragment } = channels('same-realm');
    const opened = answerHandshake({ channel: fragment, onOpen: () => undefined });

    const result = await performHostHandshake({
      channel: host,
      fragmentId: 'checkout',
      instance: weaveId(),
      assertReachable: () => undefined,
      openWith: () => ({ context: {}, props: {} }),
    });

    await expect(opened).resolves.toBeTruthy();
    expect(result.bridges).toEqual([]);

    host.close();
    fragment.close();
  });
});
