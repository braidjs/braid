import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBraidConfig } from '../config.js';
import { createContextGate, readCapabilities, resolveCapabilities } from './capabilities.js';

afterEach(() => setBraidConfig({ dev: false }));

describe('createContextGate()', () => {
  it('grants everything when no context grant is declared', () => {
    // Adding capabilities to one fragment must not silently starve every fragment that has none.
    const gate = createContextGate(undefined, 'checkout');
    expect(gate('anything')).toBe(true);
  });

  it('grants only the listed keys', () => {
    const gate = createContextGate({ context: { read: ['user', 'cart'] } }, 'checkout');
    expect(gate('user')).toBe(true);
    expect(gate('cart')).toBe(true);
    expect(gate('pricing')).toBe(false);
  });

  it('treats an empty read list as granting nothing', () => {
    const gate = createContextGate({ context: { read: [] } }, 'checkout');
    expect(gate('user')).toBe(false);
  });

  it('warns once per ungranted key in dev mode, naming the grant', () => {
    setBraidConfig({ dev: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gate = createContextGate({ context: { read: ['user'] } }, 'checkout');

    gate('pricing');
    gate('pricing');
    gate('pricing');

    // Once, not once per read: an ungranted key is usually read in a render loop.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('context.read');
    expect(warn.mock.calls[0]?.[0]).toContain('pricing');
    warn.mockRestore();
  });

  it('is silent outside dev mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createContextGate({ context: { read: [] } }, 'checkout')('user');

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('resolveCapabilities()', () => {
  it('lets the most authoritative source win', () => {
    const resolved = resolveCapabilities([
      { context: { read: ['user'] } },
      { context: { read: ['user', 'cart', 'pricing'] } },
    ]);

    // A grant written once in the registry must not be quietly widened by markup on one page.
    expect(resolved?.context?.read).toEqual(['user']);
  });

  it('keeps keys the more authoritative source has no opinion on', () => {
    const resolved = resolveCapabilities([{ context: { read: ['user'] } }, { sandbox: ['allow-popups'] }]);

    expect(resolved).toEqual({ context: { read: ['user'] }, sandbox: ['allow-popups'] });
  });

  it('skips absent sources', () => {
    expect(resolveCapabilities([undefined, { sandbox: ['allow-popups'] }, undefined])).toEqual({
      sandbox: ['allow-popups'],
    });
  });

  it('returns undefined when nothing declares anything', () => {
    expect(resolveCapabilities([undefined, undefined])).toBeUndefined();
  });
});

describe('readCapabilities()', () => {
  it('reads a capabilities block off adapter options', () => {
    expect(readCapabilities({ entry: '/main.js', capabilities: { sandbox: ['allow-popups'] } })).toEqual({
      sandbox: ['allow-popups'],
    });
  });

  it('yields undefined for options with no capabilities', () => {
    expect(readCapabilities({ entry: '/main.js' })).toBeUndefined();
    expect(readCapabilities(undefined)).toBeUndefined();
    expect(readCapabilities('nonsense')).toBeUndefined();
  });
});
