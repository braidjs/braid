import { describe, expect, it, vi } from 'vitest';
import { trustedHTML, trustedScript } from './trusted-types.js';

/**
 * Braid's one Trusted Types policy: created once per realm, only where the API exists, passing
 * values through — and stepping aside, leaving plain strings, where the host does not allow it.
 */

/** A realm with a Trusted Types factory that wraps values, so a test can tell a policy value from a string. */
function realmWithTrustedTypes(createPolicy = vi.fn((_name: string, rules: Record<string, (input: string) => string>) => ({
  createHTML: (input: string) => ({ html: rules['createHTML'](input) }),
  createScript: (input: string) => ({ script: rules['createScript'](input) }),
}))) {
  return { realm: { trustedTypes: { createPolicy } }, createPolicy };
}

describe('Braid’s Trusted Types policy', () => {
  it('passes values through a policy named braid, created once per realm', () => {
    const { realm, createPolicy } = realmWithTrustedTypes();

    expect(trustedHTML('<p>x</p>', realm)).toEqual({ html: '<p>x</p>' });
    expect(trustedScript('//', realm)).toEqual({ script: '//' });
    expect(createPolicy).toHaveBeenCalledOnce();
    expect(createPolicy.mock.calls[0][0]).toBe('braid');
  });

  it('leaves strings as they are where there is no Trusted Types', () => {
    expect(trustedHTML('<p>x</p>', {})).toBe('<p>x</p>');
    expect(trustedScript('//', {})).toBe('//');
  });

  it('leaves strings as they are where the host does not allow the policy, and asks only once', () => {
    const { realm, createPolicy } = realmWithTrustedTypes(
      vi.fn(() => {
        throw new TypeError('Policy "braid" disallowed.');
      }),
    );

    expect(trustedHTML('<p>x</p>', realm)).toBe('<p>x</p>');
    expect(trustedScript('//', realm)).toBe('//');
    expect(createPolicy).toHaveBeenCalledOnce();
  });
});
