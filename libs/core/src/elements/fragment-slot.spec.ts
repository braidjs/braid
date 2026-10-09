import { afterEach, describe, expect, it, vi } from 'vitest';
import { BraidError } from '../errors.js';
import {
  SLOT_STYLES,
  ensureFallbackSlot,
  fetchFragmentHtml,
  findPiercedContentRoot,
  FragmentRedirectError,
  FragmentSlot,
  REDIRECT_LOOP_WINDOW_MS,
  followFragmentRedirect,
  slotStateFor,
  type RedirectDeps,
} from './fragment-slot.js';

/** Builds the shadow root shape the gateway pierces into a slot. */
function piercedSlot(): ShadowRoot {
  const slot = document.createElement('fragment-slot');
  const shadowRoot = slot.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  const contentRoot = document.createElement('braid-document');
  contentRoot.append(document.createElement('braid-html'));
  shadowRoot.append(style, contentRoot);
  return shadowRoot;
}

describe('findPiercedContentRoot()', () => {
  it('finds the content root the gateway pierced in', () => {
    const shadowRoot = piercedSlot();
    expect(findPiercedContentRoot(shadowRoot)?.tagName).toBe('BRAID-DOCUMENT');
  });

  it('is not fooled by the :scope selector pitfall on a ShadowRoot', () => {
    // regression guard: `:scope > braid-document` matches nothing on a ShadowRoot, which made
    // every pierced fragment silently re-fetch. Assert the platform behavior that caused it, so
    // anyone tempted to "simplify" the helper back into a selector sees why they shouldn't.
    const shadowRoot = piercedSlot();
    expect(shadowRoot.querySelector(':scope > braid-document')).toBeNull();
    expect(findPiercedContentRoot(shadowRoot)).not.toBeNull();
  });

  it('returns null for a slot with no pierced content', () => {
    const slot = document.createElement('fragment-slot');
    const shadowRoot = slot.attachShadow({ mode: 'open' });
    shadowRoot.append(document.createElement('style'));

    expect(findPiercedContentRoot(shadowRoot)).toBeNull();
    expect(findPiercedContentRoot(null)).toBeNull();
  });

  it('ignores a braid-document that is not a direct child', () => {
    const slot = document.createElement('fragment-slot');
    const shadowRoot = slot.attachShadow({ mode: 'open' });
    const wrapper = document.createElement('div');
    wrapper.append(document.createElement('braid-document'));
    shadowRoot.append(wrapper);

    expect(findPiercedContentRoot(shadowRoot)).toBeNull();
  });
});

describe('FragmentSlot element', () => {
  it('observes name, src, and props attributes', () => {
    expect(FragmentSlot.observedAttributes).toEqual(['name', 'src', 'props']);
  });
});

describe('slotStateFor()', () => {
  it('reports connecting as ready, so existing hosts keep working', () => {
    // Every host that checks `slot.state === 'ready'` predates liveness. Renaming the state it
    // waits for would have broken all of them in exchange for a more accurate word.
    expect(slotStateFor('connecting')).toBe('ready');
  });

  it('passes every other liveness state through under its own name', () => {
    expect(slotStateFor('healthy')).toBe('healthy');
    expect(slotStateFor('unobservable')).toBe('unobservable');
    expect(slotStateFor('suspect')).toBe('suspect');
    expect(slotStateFor('gone')).toBe('gone');
  });
});

describe('ensureFallbackSlot()', () => {
  it('adds a fallback slot to a client-rendered shadow root', () => {
    const slot = document.createElement('fragment-slot');
    const shadowRoot = slot.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SLOT_STYLES;
    shadowRoot.append(style, document.createElement('braid-document'));

    ensureFallbackSlot(shadowRoot);
    expect(shadowRoot.querySelector('slot[name="fallback"]')).not.toBeNull();
  });

  it('adds one to a pierced shadow root, styles included', () => {
    // Pierced fragments arrive with a shadow root the gateway wrote. A fallback that only worked
    // for client-rendered fragments would be missing from exactly the pages that server-render
    // because their first paint matters.
    const shadowRoot = piercedSlot();
    shadowRoot.querySelector('style')?.remove();

    ensureFallbackSlot(shadowRoot);

    expect(shadowRoot.querySelector('slot[name="fallback"]')).not.toBeNull();
    expect(shadowRoot.querySelector('style')?.textContent).toContain('slot[name="fallback"]');
  });

  it('is idempotent across a reload', () => {
    const shadowRoot = piercedSlot();
    ensureFallbackSlot(shadowRoot);
    ensureFallbackSlot(shadowRoot);

    expect(shadowRoot.querySelectorAll('slot[name="fallback"]')).toHaveLength(1);
  });
});

describe('fallback styling', () => {
  it('hides fragment content and shows the fallback for gone and error', () => {
    for (const state of ['gone', 'error']) {
      expect(SLOT_STYLES).toContain(`:host([state="${state}"]) braid-document`);
      expect(SLOT_STYLES).toContain(`:host([state="${state}"]) slot[name="fallback"]`);
    }
  });

  it('leaves a suspect fragment on screen', () => {
    // Suspicion is designed to be recoverable, and replacing a working-if-sluggish UI with an
    // apology is the worse outcome.
    expect(SLOT_STYLES).not.toContain('state="suspect"');
  });
});

describe('fetchFragmentHtml()', () => {
  const routeUrl = new URL('https://host.example/goals/details/1?tab=a');

  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(response: Response | object): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  async function failure(promise: Promise<string>): Promise<BraidError> {
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(BraidError);
    return error as BraidError;
  }

  it('returns the document and refuses to follow redirects', async () => {
    const fetchMock = stubFetch(new Response('<h1>hi</h1>', { status: 200 }));

    await expect(fetchFragmentHtml('goals', routeUrl, new AbortController().signal)).resolves.toMatchObject({
      html: '<h1>hi</h1>',
    });

    // a followed redirect leaves the namespace: cross-origin it dies as an opaque CORS error, and
    // same-origin it silently injects the shell's or a login page's html as the fragment
    expect(fetchMock).toHaveBeenCalledWith(
      '/__braid/doc/goals/goals/details/1?tab=a',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('reports a browser opaque redirect as a redirect, not as HTTP 0', async () => {
    // what a browser hands back for `redirect: 'manual'`: status 0, no readable Location
    stubFetch({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() });

    const error = await failure(fetchFragmentHtml('goals', routeUrl, new AbortController().signal));

    expect(error.stage).toBe('fragment-fetch');
    expect(error.fragmentId).toBe('goals');
    expect(error.message).toContain('redirect');
    expect(error.message).not.toContain('HTTP 0');
    expect(error.fixHint).toContain('authentication');
  });

  it('names the status and Location when the redirect is readable', async () => {
    const fetchMock = stubFetch(
      new Response(null, { status: 302, headers: { location: 'https://login.example.com/x?token=secret' } }),
    );

    const error = await failure(fetchFragmentHtml('goals', routeUrl, new AbortController().signal));

    expect(error.stage).toBe('fragment-fetch');
    expect(error.message).toContain('302');
    expect(error.message).toContain('https://login.example.com/x');
    // the query string is where login redirects carry tokens; it must not reach logs
    expect(error.message).not.toContain('secret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still points a 404 at the registry', async () => {
    stubFetch(new Response('nope', { status: 404 }));

    const error = await failure(fetchFragmentHtml('goals', routeUrl, new AbortController().signal));

    expect(error.message).toContain('HTTP 404');
    expect(error.fixHint).toContain('register a manifest');
  });

  describe('when the gateway relays a redirect', () => {
    const relayed = (headers: Record<string, string>, status = 409) => new Response(null, { status, headers });

    it('turns a 409 with the gateway header into a FragmentRedirectError, keeping the query out of the message', async () => {
      stubFetch(relayed({ 'x-braid-redirect-location': 'https://login.example.com/authorize?token=secret' }));

      const error = await failure(fetchFragmentHtml('goals', routeUrl, new AbortController().signal));

      expect(error).toBeInstanceOf(FragmentRedirectError);
      expect((error as FragmentRedirectError).target).toBe('https://login.example.com/authorize?token=secret');
      expect(error.stage).toBe('fragment-fetch');
      expect(error.message).toContain('https://login.example.com/authorize');
      expect(error.message).not.toContain('secret');
    });

    it('treats a 409 without the header as the ordinary failure it is, and ignores the header on any other status', async () => {
      stubFetch(relayed({}));
      const plain = await failure(fetchFragmentHtml('goals', routeUrl, new AbortController().signal));
      expect(plain).not.toBeInstanceOf(FragmentRedirectError);
      expect(plain.message).toContain('HTTP 409');

      stubFetch(
        new Response('<h1>hi</h1>', { status: 200, headers: { 'x-braid-redirect-location': 'https://evil.example' } }),
      );
      await expect(fetchFragmentHtml('goals', routeUrl, new AbortController().signal)).resolves.toMatchObject({ html: '<h1>hi</h1>' });
    });

    it('tells the gateway which page the user is on, so a login can send them back to it', async () => {
      const fetchMock = stubFetch(new Response('ok'));

      await fetchFragmentHtml('goals', routeUrl, new AbortController().signal);

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>)['x-braid-return-url']).toBe(location.href);
    });
  });
});

describe('followFragmentRedirect()', () => {
  const redirect = (target = 'https://login.example.com/authorize?next=a') =>
    new FragmentRedirectError('goals', target, '/__braid/doc/goals/x');

  /** Dependencies with an in-memory sessionStorage, so a "page load" is a new call with the same store. */
  function deps(overrides: Partial<RedirectDeps> = {}, store = new Map<string, string>()) {
    const assign = vi.fn();
    const value: RedirectDeps = {
      assign,
      storage: () => ({ getItem: (key) => store.get(key) ?? null, setItem: (key, v) => void store.set(key, v) }),
      now: () => 1_000_000,
      baseHref: 'https://host.example/goals',
      inFlight: new Set<string>(),
      ...overrides,
    };
    return { value, assign, store };
  }

  it('navigates the page to the target, once', () => {
    const { value, assign } = deps();

    expect(followFragmentRedirect(redirect(), value)).toBeNull();

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('https://login.example.com/authorize?next=a');
  });

  it('resolves a host-relative target against the page', () => {
    const { value, assign } = deps();

    followFragmentRedirect(redirect('/login?next=%2Fgoals'), value);

    expect(assign).toHaveBeenCalledWith('https://host.example/login?next=%2Fgoals');
  });

  it.each(['javascript:alert(1)', 'data:text/html,x'])('refuses %s', (target) => {
    const { value, assign } = deps();

    const refusal = followFragmentRedirect(redirect(target), value);

    expect(refusal).toBeInstanceOf(BraidError);
    expect(assign).not.toHaveBeenCalled();
  });

  it('stops a loop: a second redirect straight after the first is an error that names the fix', () => {
    const store = new Map<string, string>();
    const first = deps({}, store);
    expect(followFragmentRedirect(redirect(), first.value)).toBeNull();

    const second = deps({ now: () => 1_000_000 + REDIRECT_LOOP_WINDOW_MS - 1 }, store);
    const refusal = followFragmentRedirect(redirect(), second.value);

    expect(second.assign).not.toHaveBeenCalled();
    expect(refusal?.fixHint).toContain('forwardCredentials');
  });

  it('allows a redirect again once the window has passed, and tracks fragments separately', () => {
    const store = new Map<string, string>();
    followFragmentRedirect(redirect(), deps({}, store).value);

    const later = deps({ now: () => 1_000_000 + REDIRECT_LOOP_WINDOW_MS }, store);
    expect(followFragmentRedirect(redirect(), later.value)).toBeNull();
    expect(later.assign).toHaveBeenCalledTimes(1);

    const other = deps({}, store);
    expect(followFragmentRedirect(new FragmentRedirectError('billing', 'https://login.example.com/', '/x'), other.value)).toBeNull();
  });

  it('fails closed when sessionStorage is unavailable', () => {
    const { value, assign } = deps({
      storage: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });

    const refusal = followFragmentRedirect(redirect(), value);

    expect(assign).not.toHaveBeenCalled();
    expect(refusal?.message).toContain('sessionStorage');
  });

  it('refuses a path that resolves to another origin, whatever the gateway said', () => {
    // `//evil.net` is a perfectly good path to a URL parser and a perfectly good host to a reader
    for (const target of ['//evil.net/x', '/\\evil.net/x']) {
      const { value, assign } = deps();

      expect(followFragmentRedirect(redirect(target), value)).toBeInstanceOf(BraidError);
      expect(assign).not.toHaveBeenCalled();
    }
  });

  it('does not treat a second slot hearing the same redirect as a loop', () => {
    const shared = deps();

    expect(followFragmentRedirect(redirect(), shared.value)).toBeNull();
    expect(followFragmentRedirect(redirect(), shared.value)).toBeNull();

    expect(shared.assign).toHaveBeenCalledTimes(1);
  });

  it('does not let a stamp from the future block a fragment for good', () => {
    const store = new Map([['braid:redirect:goals', String(1_000_000 + 10 * REDIRECT_LOOP_WINDOW_MS)]]);
    const { value, assign } = deps({}, store);

    expect(followFragmentRedirect(redirect(), value)).toBeNull();
    expect(assign).toHaveBeenCalledTimes(1);
  });
});
