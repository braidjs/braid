import { afterEach, describe, expect, it, vi } from 'vitest';
import { initBraid } from './index.js';
import { setBraidConfig } from './config.js';

/**
 * `initBraid({ basePath })`: a host mounted under `/manage/` reaches its gateway's namespaces
 * there, never at the root of a domain it does not own.
 */
describe('client basePath', () => {
  afterEach(() => {
    setBraidConfig({ basePath: '' });
    document.body.replaceChildren();
    history.replaceState(null, '', '/');
    vi.unstubAllGlobals();
  });

  it('requests the fragment document and realm stub under the mount', async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        fetched.push(String(input));
        return new Response('<h1>Goals</h1>', { headers: { 'content-type': 'text/html' } });
      }),
    );
    history.replaceState(null, '', '/manage/goals/accounts/123?x=1');

    initBraid({ basePath: '/manage/' });
    document.body.innerHTML = '<fragment-slot name="goals"></fragment-slot>';

    await vi.waitFor(() => {
      expect(document.querySelector('iframe')).not.toBeNull();
      expect(fetched).not.toHaveLength(0);
    });

    expect(fetched[0]).toBe('/manage/__braid/doc/goals/manage/goals/accounts/123?x=1');
    // one stub per fragment, whatever the route; its <base> is pointed at the route after load
    expect(document.querySelector('iframe')!.getAttribute('src')).toBe('/manage/__braid/realm/goals/');
  });

  it('rejects a basePath that is not an absolute path', () => {
    expect(() => initBraid({ basePath: 'manage' })).toThrow(/basePath/);
    // one the URL parser would rewrite could never match a parsed request path
    expect(() => initBraid({ basePath: '/café' })).toThrow(/basePath/);
    expect(() => initBraid({ basePath: '/a/./b' })).toThrow(/basePath/);
  });
});
