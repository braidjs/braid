import { describe, expect, it } from 'vitest';
import { parseOriginRules, resolveRedirectTarget, resolveReturnUrl, rewriteReturnUrls } from './redirect.js';

const requestUrl = new URL('https://example.com/__braid/doc/billing/invoices');
const endpoint = 'https://internal.example/apps/billing/';
const fragmentRequestUrl = new URL('https://internal.example/apps/billing/invoices');

function resolve(
  location: string,
  origins: string[] = [],
  overrides: { endpoint?: string | undefined; requestedUrl?: URL } = {},
) {
  return resolveRedirectTarget({
    location,
    fragmentRequestUrl: overrides.requestedUrl ?? fragmentRequestUrl,
    endpoint: 'endpoint' in overrides ? overrides.endpoint : endpoint,
    requestUrl,
    allowedOrigins: parseOriginRules(origins),
  });
}

describe('parseOriginRules()', () => {
  it('accepts exact origins and subdomain wildcards', () => {
    expect(() => parseOriginRules(['https://login.example.com', 'https://*.example.com', 'http://localhost:4000'])).not.toThrow();
  });

  it.each(['login.example.com', 'https://login.example.com/path', 'ftp://example.com', 'https://example.com?x=1', 'nope'])(
    'rejects %s at construction',
    (entry) => {
      expect(() => parseOriginRules([entry])).toThrow(/redirectOrigins/);
    },
  );
});

describe('resolveRedirectTarget()', () => {
  it('maps a path inside the fragment endpoint back to the host', () => {
    expect(resolve('/apps/billing/login?next=%2Fx')).toEqual({ ok: true, target: '/login?next=%2Fx' });
    expect(resolve('https://internal.example/apps/billing/login#a')).toEqual({ ok: true, target: '/login#a' });
    expect(resolve('login')).toEqual({ ok: true, target: '/login' });
  });

  it("allows the host's own origin, including a /__braid/ path", () => {
    expect(resolve('https://example.com/sign-in?a=1')).toEqual({ ok: true, target: '/sign-in?a=1' });
    expect(resolve('https://example.com/__braid/doc/login/')).toEqual({ ok: true, target: '/__braid/doc/login/' });
  });

  it('allows a listed origin, exact or by subdomain wildcard, as an absolute URL', () => {
    expect(resolve('https://login.vendor.com/authorize?x=1', ['https://login.vendor.com'])).toEqual({
      ok: true,
      target: 'https://login.vendor.com/authorize?x=1',
    });
    expect(resolve('https://sso.example.com/a', ['https://*.example.com'])).toEqual({
      ok: true,
      target: 'https://sso.example.com/a',
    });
    expect(resolve('https://a.b.example.com/a', ['https://*.example.com']).ok).toBe(true);
  });

  it('does not let a wildcard match the apex, a lookalike, or another scheme or port', () => {
    const wildcard = ['https://*.example.com'];
    expect(resolve('https://example.com.evil.net/a', wildcard).ok).toBe(false);
    expect(resolve('https://evilexample.com/a', wildcard).ok).toBe(false);
    expect(resolve('http://sso.example.com/a', wildcard).ok).toBe(false);
    expect(resolve('https://sso.example.com:8443/a', wildcard).ok).toBe(false);
  });

  it.each([
    '/apps/billing//evil.net',
    '/apps/billing/.//evil.net',
    '/apps/billing/\\evil.net',
    'https://example.com//evil.net',
    'https://example.com/\\evil.net',
  ])('never emits a path that a reader would take for another host: %s', (location) => {
    const result = resolve(location);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.startsWith('//')).toBe(false);
      expect(new URL(result.target, 'https://example.com/page').origin).toBe('https://example.com');
    }
  });

  it('does the same when the endpoint has no base path', () => {
    const result = resolve('https://internal.example//evil.net', [], { endpoint: 'https://internal.example' });

    expect(result.ok && result.target.startsWith('//')).toBe(false);
  });

  it('refuses credentials in the URL, even on an allowed host', () => {
    expect(resolve('https://user:pw@sso.example.com/x', ['https://*.example.com']).ok).toBe(false);
  });

  it('does not match the apex of a wildcard, or a lookalike', () => {
    expect(resolve('https://apex.test/x', ['https://*.apex.test']).ok).toBe(false);
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd'])('refuses %s', (location) => {
    expect(resolve(location, ['https://*.example.com']).ok).toBe(false);
  });

  it('refuses the endpoint origin outside its own path, and any unlisted origin, without echoing the query', () => {
    const outside = resolve('https://internal.example/admin?token=secret');
    const unlisted = resolve('https://elsewhere.net/x?token=secret');

    for (const result of [outside, unlisted]) {
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('secret');
    }
  });

  it('treats a function endpoint as living on the host', () => {
    // a function endpoint is asked for the host-side URL, so a relative Location resolves on the host
    const requestedUrl = new URL('https://example.com/invoices');
    expect(resolve('/login', [], { endpoint: undefined, requestedUrl })).toEqual({ ok: true, target: '/login' });
  });
});

describe('resolveReturnUrl()', () => {
  it('prefers the header, falls back to referer, and only ever names a page on the gateway origin', () => {
    expect(resolveReturnUrl(requestUrl, 'https://example.com/a?b=1', null)?.href).toBe('https://example.com/a?b=1');
    expect(resolveReturnUrl(requestUrl, null, 'https://example.com/r')?.href).toBe('https://example.com/r');
    expect(resolveReturnUrl(requestUrl, 'https://evil.net/a', null)).toBeNull();
    expect(resolveReturnUrl(requestUrl, 'https://example.com/__braid/doc/x', null)).toBeNull();
    // and still not when the gateway is mounted under a basePath
    expect(resolveReturnUrl(requestUrl, 'https://example.com/manage/__braid/doc/x', null)).toBeNull();
    expect(resolveReturnUrl(requestUrl, 'not a url', null)).toBeNull();
  });
});

describe('rewriteReturnUrls()', () => {
  const context = { fragmentRequestUrl, requestUrl, strippedUrl: new URL('https://example.com/invoices') };
  const page = new URL('https://example.com/billing/invoices?tab=open');

  it("points a return parameter at the page instead of the fragment's own URL", () => {
    expect(rewriteReturnUrls('/login?next=https%3A%2F%2Finternal.example%2Fapps%2Fbilling%2Finvoices%3Fa%3D1', page, context)).toBe(
      '/login?next=https%3A%2F%2Fexample.com%2Fbilling%2Finvoices%3Ftab%3Dopen',
    );
  });

  it('keeps a path a path, and handles the host-visible path the fragment was shown', () => {
    expect(rewriteReturnUrls('/login?return_to=%2Finvoices', page, context)).toBe(
      '/login?return_to=%2Fbilling%2Finvoices%3Ftab%3Dopen',
    );
  });

  it('works on an absolute target, and leaves unrelated parameters alone', () => {
    const result = rewriteReturnUrls(
      'https://sso.vendor.com/authorize?client_id=abc&redirect=https%3A%2F%2Fexample.com%2Finvoices',
      page,
      context,
    );
    const url = new URL(result);
    expect(url.searchParams.get('client_id')).toBe('abc');
    expect(url.searchParams.get('redirect')).toBe('https://example.com/billing/invoices?tab=open');
  });

  it('does not touch a parameter that points somewhere else, or when there is no return page', () => {
    const target = '/login?next=https%3A%2F%2Felsewhere.net%2Finvoices&x=%2Fother';
    expect(rewriteReturnUrls(target, page, context)).toBe(target);
    expect(rewriteReturnUrls('/login?next=%2Finvoices', null, context)).toBe('/login?next=%2Finvoices');
  });

  it('never writes a protocol-relative return path into the target', () => {
    const sneaky = new URL('https://example.com//evil.net/x');
    const rewritten = rewriteReturnUrls('/login?next=%2Finvoices', sneaky, context);

    expect(decodeURIComponent(new URL(rewritten, 'https://example.com').searchParams.get('next')!).startsWith('//')).toBe(false);
  });

  it('keeps every parameter it does not rewrite byte for byte, and rewrites each duplicate', () => {
    const result = rewriteReturnUrls('/login?flag&t=a~b&bad=%E9&next=%2Finvoices&next=%2Finvoices', page, context);

    expect(result).toContain('?flag&t=a~b&bad=%E9&');
    expect(result.match(/next=/g)).toHaveLength(2);
    expect(result).not.toContain('next=%2Finvoices');
  });

  it("leaves a redirect_uri that is the fragment's bare root alone", () => {
    const rootContext = { ...context, fragmentRequestUrl: new URL('https://internal.example/apps/billing/') };
    const target = '/authorize?redirect_uri=https%3A%2F%2Fexample.com%2F';

    expect(
      rewriteReturnUrls(target, page, { ...rootContext, strippedUrl: new URL('https://example.com/'), requestUrl: new URL('https://example.com/') }),
    ).toBe(target);
  });
});
