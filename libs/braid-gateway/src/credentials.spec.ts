import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGateway } from './gateway.js';

/**
 * The trust boundary between a shell and the fragments it composes.
 *
 * A fragment endpoint is a URL from the registry — frequently a different team, often a different
 * company. `Cookie` and `Authorization` authenticate the caller to the *shell's* origin, so
 * forwarding them hands every fragment backend the ability to act as that user against it.
 *
 * `new Request(url, request)` copies every header, so this is not automatic. These tests are what
 * keeps it true.
 */

const registry = [{ id: 'billing', endpoint: 'https://billing.internal' }];
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** Captures the request the gateway makes to the fragment endpoint. */
function captureFragmentFetch(): { sent(): Request } {
  const calls: Request[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(input instanceof Request ? input : new Request(input, init));
    return new Response('<p>fragment</p>', { headers: { 'content-type': 'text/html' } });
  }) as unknown as typeof fetch;

  return {
    sent() {
      if (calls.length === 0) throw new Error('the gateway made no fragment request');
      return calls[0]!;
    },
  };
}

function signedInRequest() {
  return new Request('https://shell.example.com/__braid/frag/billing/invoices', {
    headers: {
      cookie: 'session=a-real-session-value; theme=dark',
      authorization: 'Bearer a-token-for-the-shell',
      accept: 'text/html',
      'accept-language': 'en-GB',
    },
  });
}

describe('caller credentials and fragment endpoints', () => {
  it('does not forward Cookie or Authorization by default', async () => {
    const captured = captureFragmentFetch();
    await createGateway({ registry }).handle(signedInRequest());

    expect(captured.sent().headers.get('cookie')).toBeNull();
    expect(captured.sent().headers.get('authorization')).toBeNull();
  });

  it('forwards everything else, so this strips credentials rather than blanking the request', async () => {
    const captured = captureFragmentFetch();
    await createGateway({ registry }).handle(signedInRequest());

    expect(captured.sent().headers.get('accept')).toBe('text/html');
    expect(captured.sent().headers.get('accept-language')).toBe('en-GB');
    expect(captured.sent().headers.get('x-forwarded-host')).toBe('shell.example.com');
  });

  it('forwards them when the host declares one trust boundary', async () => {
    const captured = captureFragmentFetch();
    await createGateway({ registry, forwardCredentials: true }).handle(signedInRequest());

    expect(captured.sent().headers.get('cookie')).toBe('session=a-real-session-value; theme=dark');
    expect(captured.sent().headers.get('authorization')).toBe('Bearer a-token-for-the-shell');
  });

  it('lets additionalHeaders supply an Authorization the fragment *should* see', async () => {
    // The strip runs first, so a host can replace the caller's credential with one scoped to
    // this fragment — which is the pattern that makes the default safe to live with.
    const captured = captureFragmentFetch();
    await createGateway({
      registry,
      additionalHeaders: { authorization: 'Bearer minted-for-billing' },
    }).handle(signedInRequest());

    expect(captured.sent().headers.get('authorization')).toBe('Bearer minted-for-billing');
  });
});

describe('additionalHeaders as a function', () => {
  it('is called per request with the incoming request', async () => {
    const captured = captureFragmentFetch();
    const seen: string[] = [];

    const gateway = createGateway({
      registry,
      additionalHeaders: (request) => {
        seen.push(request.headers.get('x-user') ?? 'anonymous');
        return { 'x-braid-identity': `assertion-for-${request.headers.get('x-user') ?? 'anonymous'}` };
      },
    });

    await gateway.handle(new Request('https://shell.example.com/__braid/frag/billing/a', {
      headers: { 'x-user': 'alice' },
    }));

    expect(seen).toEqual(['alice']);
    expect(captured.sent().headers.get('x-braid-identity')).toBe('assertion-for-alice');
  });

  it('is re-evaluated for each caller, which a static record cannot be', async () => {
    // The reason this option accepts a function at all: an identity assertion is per-user and
    // per-request by definition, and a Record read once at construction has nowhere to put one.
    const identities: (string | null)[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      identities.push(request.headers.get('x-braid-identity'));
      return new Response('<p>fragment</p>', { headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;

    const gateway = createGateway({
      registry,
      additionalHeaders: (request) => ({ 'x-braid-identity': String(request.headers.get('x-user')) }),
      // Coalescing would collapse two identical URLs into one fetch; these must stay distinct.
      coalesceFragmentFetches: false,
    });

    await gateway.handle(new Request('https://shell.example.com/__braid/frag/billing/a', {
      headers: { 'x-user': 'alice' },
    }));
    await gateway.handle(new Request('https://shell.example.com/__braid/frag/billing/a', {
      headers: { 'x-user': 'bob' },
    }));

    expect(identities).toEqual(['alice', 'bob']);
  });

  it('still accepts a plain record', async () => {
    const captured = captureFragmentFetch();
    await createGateway({ registry, additionalHeaders: { 'x-tenant': 'acme' } })
      .handle(new Request('https://shell.example.com/__braid/frag/billing/a'));

    expect(captured.sent().headers.get('x-tenant')).toBe('acme');
  });
});
