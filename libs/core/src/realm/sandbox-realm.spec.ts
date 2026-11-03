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

  it.each([
    'javascript:parent.document.cookie',
    'JavaScript:alert(1)',
    'data:text/html,<script>parent.x=1</script>',
    'blob:https://vendor.example.com/0b9c',
    'about:blank',
  ])('refuses %s, whose opaque origin would otherwise pass as cross-origin', (src) => {
    // An opaque origin is "null", never the host's, so only the scheme check stops these. With
    // `allow-same-origin` a javascript: src runs in the host's own origin.
    expect(() => assertCrossOrigin(src, 'analytics')).toThrow(/not an https url/);
  });

  it('refuses plain http off loopback', () => {
    expect(() => assertCrossOrigin('http://vendor.example.com/widget', 'analytics')).toThrow(/not an https url/);
  });

  it('accepts plain http on a loopback host, for local development', () => {
    expect(assertCrossOrigin('http://127.0.0.1:4300/widget', 'analytics')).toBe('http://127.0.0.1:4300');
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

  it.each([
    ['in another case', ['ALLOW-TOP-NAVIGATION']],
    ['inside a whitespace-separated entry', ['allow-popups allow-top-navigation']],
    ['as the custom-protocols variant', ['allow-top-navigation-to-custom-protocols']],
  ])('refuses allow-top-navigation %s', (_label, requested) => {
    // The browser lowercases and splits the attribute, so the check must see what it will see.
    expect(() => resolveSandboxTokens(requested, 'analytics')).toThrow(/never granted/);
  });

  it('refuses allow-popups-to-escape-sandbox, which reaches the host page through window.opener', () => {
    expect(() => resolveSandboxTokens(['allow-popups', 'allow-popups-to-escape-sandbox'], 'analytics')).toThrow(
      /never granted/,
    );
  });

  it('refuses a token the standard does not define', () => {
    expect(() => resolveSandboxTokens(['allow-everything'], 'analytics')).toThrow(/not a sandbox token/);
  });

  it('normalizes case and splits entries, as the browser will', () => {
    expect(resolveSandboxTokens(['ALLOW-Popups allow-modals'], 'analytics')).toEqual([
      'allow-scripts',
      'allow-forms',
      'allow-popups',
      'allow-modals',
    ]);
  });

  it('permits the user-activation variant', () => {
    expect(resolveSandboxTokens(['allow-top-navigation-by-user-activation'], 'analytics')).toContain(
      'allow-top-navigation-by-user-activation',
    );
  });
});
