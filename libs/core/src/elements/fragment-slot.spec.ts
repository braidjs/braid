import { afterEach, describe, expect, it, vi } from 'vitest';
import { BraidError } from '../errors.js';
import {
  SLOT_STYLES,
  ensureFallbackSlot,
  fetchFragmentHtml,
  findPiercedContentRoot,
  FragmentSlot,
  slotStateFor,
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
});
