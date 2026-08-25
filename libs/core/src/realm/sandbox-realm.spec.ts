import { describe, expect, it } from 'vitest';
import { BraidError } from '../errors.js';
import { DEFAULT_SANDBOX_TOKENS, assertCrossOrigin, resolveSandboxTokens } from './sandbox-realm.js';

describe('assertCrossOrigin()', () => {
  it('accepts a cross-origin url and returns its origin', () => {
    expect(assertCrossOrigin('https://vendor.example.com/widget', 'analytics')).toBe('https://vendor.example.com');
  });

  it('refuses the host’s own origin', () => {
    /**
     * The most important check in the tier. `sandbox="allow-scripts allow-same-origin"` on a
     * same-origin frame is a sandbox that isn't one — the framed document can reach into the host
     * and clear its own sandbox attribute — and the markup looks locked down while it happens.
     */
    const error = (() => {
      try {
        assertCrossOrigin(`${location.origin}/widget`, 'analytics');
      } catch (e) {
        return e;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(BraidError);
    expect((error as BraidError).stage).toBe('slot-config');
    expect((error as BraidError).fixHint).toContain('different origin');
  });

  it('refuses a relative url, which is always same-origin', () => {
    expect(() => assertCrossOrigin('/widget', 'analytics')).toThrow(BraidError);
  });

  it('refuses an unparseable url', () => {
    expect(() => assertCrossOrigin('http://[not a url', 'analytics')).toThrow(BraidError);
  });
});

describe('resolveSandboxTokens()', () => {
  it('grants scripts and forms by default', () => {
    // A fragment that cannot run scripts is not an application; a form post is the least
    // surprising thing a page does. Everything beyond these is opted into deliberately.
    expect(resolveSandboxTokens(undefined, 'analytics')).toEqual([...DEFAULT_SANDBOX_TOKENS]);
  });

  it('adds host-declared tokens', () => {
    expect(resolveSandboxTokens(['allow-popups'], 'analytics')).toEqual([
      'allow-scripts',
      'allow-forms',
      'allow-popups',
    ]);
  });

  it('does not duplicate a token that is already default', () => {
    expect(resolveSandboxTokens(['allow-scripts'], 'analytics')).toEqual([...DEFAULT_SANDBOX_TOKENS]);
  });

  it('refuses allow-top-navigation, pointing at the safe variant', () => {
    // The classic route from "embedded widget" to "phishing redirect".
    const error = (() => {
      try {
        resolveSandboxTokens(['allow-top-navigation'], 'analytics');
      } catch (e) {
        return e;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(BraidError);
    expect((error as BraidError).fixHint).toContain('allow-top-navigation-by-user-activation');
  });

  it('permits the user-activation variant', () => {
    expect(resolveSandboxTokens(['allow-top-navigation-by-user-activation'], 'analytics')).toContain(
      'allow-top-navigation-by-user-activation',
    );
  });
});
