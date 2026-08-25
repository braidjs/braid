import { versioned } from '@braidlabs/skew';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { braidContext, createContextBus } from './context-bus.js';
import { createBoundaryChannel } from '../weave/channel.js';
import { createSameRealmBackingPair } from '../weave/same-realm-backing.js';
import { attachContextRouter, createContextMirror } from '../weave/context-bridge.js';

afterEach(() => braidContext.clear());

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createContextBus()', () => {
  it('is isolated from the page bus in both directions', () => {
    const local = createContextBus();

    braidContext.set('cart', { items: 1 });
    local.set('draft', { body: 'unsent' });

    expect(local.get('cart')).toBeUndefined();
    expect(braidContext.get('draft')).toBeUndefined();
  });

  it('keeps the full bus semantics, versioning included', () => {
    interface V1 { ticker: string }
    interface V2 extends V1 { market: string }
    const local = createContextBus();
    local.register(
      'instrument',
      versioned<V1>('spec.local-instrument').next<V2>('carry the market', {
        up: (v1) => ({ ...v1, market: '' }),
        down: ({ market: _market, ...rest }) => rest,
        lossy: ['market'],
      }),
    );
    local.set('instrument', { ticker: 'ACME', market: 'XNYS' });

    // A second bus is a second *bus*, not a second map: the versioning is what makes it one, and
    // it is per-instance by nature.
    expect(local.get('instrument', { as: 1 })).toEqual({ ticker: 'ACME' });
  });

  it('gives each bus its own observers', () => {
    const local = createContextBus();
    const onPage = vi.fn();
    const onLocal = vi.fn();
    braidContext.observe(onPage);
    local.observe(onLocal);

    local.set('draft', { body: 'unsent' });

    expect(onLocal).toHaveBeenCalledWith('draft');
    expect(onPage).not.toHaveBeenCalled();
  });
});

describe('scoped routing across the boundary', () => {
  /** Two routers and two mirrors on one channel — the case scope addressing exists for. */
  function twoBuses() {
    const signal = new AbortController().signal;
    const backings = createSameRealmBackingPair();
    const host = createBoundaryChannel({ backing: backings.host, fragmentId: 'checkout', instance: 'i1', signal });
    const fragment = createBoundaryChannel({ backing: backings.fragment, fragmentId: 'checkout', instance: 'i1', signal });

    const local = createContextBus();

    const pageMirror = createContextMirror(fragment);
    const localMirror = createContextMirror(fragment, 'local');

    const pageSnapshot = attachContextRouter({
      bus: braidContext,
      channel: host,
      fragmentId: 'checkout',
      contextVersions: {},
      signal,
    });
    const localSnapshot = attachContextRouter({
      bus: local,
      channel: host,
      fragmentId: 'checkout',
      contextVersions: {},
      scope: 'local',
      signal,
    });

    pageMirror.seed({ context: pageSnapshot, props: {} });
    localMirror.seed({ context: localSnapshot, props: {} });

    return { local, pageMirror, localMirror };
  }

  it('delivers each bus’s changes to its own mirror only', async () => {
    const { local, pageMirror, localMirror } = twoBuses();

    braidContext.set('cart', { items: 2 });
    local.set('draft', { body: 'unsent' });
    await flush();

    expect(pageMirror.get('cart')).toEqual({ items: 2 });
    expect(pageMirror.get('draft')).toBeUndefined();
    expect(localMirror.get('draft')).toEqual({ body: 'unsent' });
    expect(localMirror.get('cart')).toBeUndefined();
  });

  it('does not let a page key shadow a private key of the same name', async () => {
    const { local, pageMirror, localMirror } = twoBuses();

    braidContext.set('user', { id: 'public' });
    local.set('user', { id: 'private' });
    await flush();

    // Without scope in the handler address, the second `ctx/changed` registration would silently
    // displace the first and one of these two buses would simply go quiet.
    expect(pageMirror.get('user')).toEqual({ id: 'public' });
    expect(localMirror.get('user')).toEqual({ id: 'private' });
  });

  it('notifies subscribers on the right bus', async () => {
    const { local, pageMirror, localMirror } = twoBuses();
    const onPage = vi.fn();
    const onLocal = vi.fn();
    pageMirror.subscribe('shared', onPage);
    localMirror.subscribe('shared', onLocal);

    local.set('shared', { from: 'local' });
    await flush();

    expect(onLocal).toHaveBeenCalledWith({ from: 'local' });
    expect(onPage).not.toHaveBeenCalled();
  });
});
