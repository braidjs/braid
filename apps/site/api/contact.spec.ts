import { describe, expect, it, vi } from 'vitest';
import { handleContact, type ContactDeps, type ContactMessage } from './contact';

const ORIGIN = 'https://braid.example';

const valid = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company: 'Analytical Engines',
  message: 'We run four frontends and would like Braid hosted for us.',
  'cf-turnstile-response': 'token-ok',
};

function deps(overrides: Partial<ContactDeps> = {}) {
  const sent: ContactMessage[] = [];
  const all: ContactDeps = {
    clientIp: vi.fn(() => '203.0.113.7'),
    rateLimit: vi.fn(async () => true),
    verifyTurnstile: vi.fn(async () => true),
    send: vi.fn(async (message: ContactMessage) => void sent.push(message)),
    log: vi.fn(),
    ...overrides,
  };
  return { deps: all, sent };
}

function post(fields: Record<string, string>, { json = false, headers = {} as Record<string, string> } = {}) {
  const body = new URLSearchParams(fields);
  return new Request(`${ORIGIN}/api/contact`, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      'cf-connecting-ip': '203.0.113.7',
      ...(json ? { accept: 'application/json' } : {}),
      ...headers,
    },
  });
}

describe('POST /api/contact', () => {
  it('sends a valid enquiry and redirects a plain form post to the thanks page', async () => {
    const { deps: d, sent } = deps();
    const res = await handleContact(post(valid), d);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/contact/thanks/');
    expect(sent).toEqual([{ name: valid.name, email: valid.email, company: valid.company, message: valid.message }]);
    expect(d.verifyTurnstile).toHaveBeenCalledWith('token-ok', '203.0.113.7');
  });

  it('answers JSON to a script that asks for it', async () => {
    const res = await handleContact(post(valid, { json: true }), deps().deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('accepts multipart form data too, which is what FormData sends', async () => {
    const form = new FormData();
    for (const [k, v] of Object.entries(valid)) form.set(k, v);
    const req = new Request(`${ORIGIN}/api/contact`, { method: 'POST', body: form, headers: { origin: ORIGIN } });
    expect((await handleContact(req, deps().deps)).status).toBe(303);
  });

  it.each([
    ['name', { name: '' }, 'name'],
    ['email', { email: '' }, 'email'],
    ['a malformed email', { email: 'not-an-email' }, 'email'],
    ['an email with a line break', { email: 'ada@example.com\r\nBcc: x@evil.test' }, 'email'],
    ['message', { message: '' }, 'message'],
    ['a message over 5,000 characters', { message: 'x'.repeat(5001) }, 'message'],
    ['a name over 100 characters', { name: 'x'.repeat(101) }, 'name'],
    // Characters RFC 5322 gives meaning to in an address header: each could turn Reply-To into a
    // list, a group or a comment. Only plain addresses are accepted.
    ['an email with a comma', { email: 'ceo,attacker@evil.test' }, 'email'],
    ['an email with a semicolon', { email: 'a;b@evil.test' }, 'email'],
    ['an email with quotes', { email: '"a"@evil.test' }, 'email'],
    ['an email with a comment', { email: 'a(b)@evil.test' }, 'email'],
    ['an email with a control character', { email: 'a\u0000b@evil.test' }, 'email'],
  ])('refuses a missing or invalid %s with a 400 naming the field', async (_label, change, field) => {
    const { deps: d, sent } = deps();
    const res = await handleContact(post({ ...valid, ...change }, { json: true }), d);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; errors: Record<string, string> };
    expect(body.ok).toBe(false);
    expect(Object.keys(body.errors)).toContain(field);
    expect(sent).toHaveLength(0);
  });

  it('shows the errors as a readable page when there is no script', async () => {
    const res = await handleContact(post({ ...valid, email: 'nope' }), deps().deps);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('email address');
    expect(html).not.toContain('<script');
  });

  it('refuses a submission with no Turnstile token, without asking Cloudflare', async () => {
    const { deps: d, sent } = deps();
    const noToken = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'cf-turnstile-response'));
    const res = await handleContact(post(noToken, { json: true }), d);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: object }).errors).toHaveProperty('turnstile');
    expect(d.verifyTurnstile).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('refuses a submission whose Turnstile check fails', async () => {
    const { deps: d, sent } = deps({ verifyTurnstile: vi.fn(async () => false) });
    const res = await handleContact(post(valid, { json: true }), d);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: object }).errors).toHaveProperty('turnstile');
    expect(sent).toHaveLength(0);
  });

  it('drops a filled honeypot silently: it looks like success, and nothing is sent', async () => {
    const { deps: d, sent } = deps();
    const res = await handleContact(post({ ...valid, hp_extra: 'http://spam.test' }), d);
    expect(res.status).toBe(303);
    expect(sent).toHaveLength(0);
    expect(d.verifyTurnstile).not.toHaveBeenCalled();
  });

  it('does not spend the rate limit on a submission that fails validation', async () => {
    const { deps: d } = deps();
    await handleContact(post({ ...valid, email: 'nope' }, { json: true }), d);
    expect(d.rateLimit).not.toHaveBeenCalled();
  });

  it('fails closed when the platform cannot say who is asking', async () => {
    const { deps: d, sent } = deps({ clientIp: vi.fn(() => null) });
    const res = await handleContact(post(valid, { json: true }), d);
    expect(res.status).toBe(400);
    expect(d.rateLimit).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('marks every response with nosniff and no-store, and locks down the HTML error page', async () => {
    const json = await handleContact(post({ ...valid, email: 'nope' }, { json: true }), deps().deps);
    expect(json.headers.get('x-content-type-options')).toBe('nosniff');
    expect(json.headers.get('cache-control')).toBe('no-store');
    const html = await handleContact(post({ ...valid, email: 'nope' }), deps().deps);
    expect(html.headers.get('content-security-policy')).toMatch(/default-src 'none'.*frame-ancestors 'none'/);
    const ok = await handleContact(post(valid), deps().deps);
    expect(ok.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 429 once the rate limit is used up, keyed by the visitor IP', async () => {
    const { deps: d, sent } = deps({ rateLimit: vi.fn(async () => false) });
    const res = await handleContact(post(valid), d);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(d.rateLimit).toHaveBeenCalledWith('203.0.113.7');
    expect(sent).toHaveLength(0);
  });

  it.each(['GET', 'PUT', 'DELETE'])('answers %s with 405 and an Allow header', async (method) => {
    const res = await handleContact(new Request(`${ORIGIN}/api/contact`, { method }), deps().deps);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('accepts a post with no Origin header (a script or curl), which is not a cross-site browser post', async () => {
    const req = post(valid);
    const noOrigin = new Request(req, { headers: Object.fromEntries([...req.headers].filter(([k]) => k !== 'origin')) });
    expect((await handleContact(noOrigin, deps().deps)).status).toBe(303);
  });

  it('answers the honeypot with JSON success too, and logs that it dropped one', async () => {
    const { deps: d, sent } = deps();
    const res = await handleContact(post({ ...valid, hp_extra: 'x' }, { json: true }), d);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
    expect(d.log).toHaveBeenCalledWith('contact: honeypot filled; dropped');
  });

  it('answers a body it cannot read as a form with 400', async () => {
    const req = new Request(`${ORIGIN}/api/contact`, {
      method: 'POST',
      body: 'not a form',
      headers: { 'content-type': 'multipart/form-data; boundary=missing', accept: 'application/json' },
    });
    const res = await handleContact(req, deps().deps);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: object }).errors).toHaveProperty('form');
  });

  it('refuses a post from another site', async () => {
    const { deps: d, sent } = deps();
    const res = await handleContact(post(valid, { headers: { origin: 'https://evil.test' } }), d);
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('refuses an oversized body with 413, before validating anything', async () => {
    const { deps: d, sent } = deps();
    const res = await handleContact(post({ ...valid, message: 'x'.repeat(40_000) }), d);
    expect(res.status).toBe(413);
    expect(sent).toHaveLength(0);
  });

  it('reports a failed send as 502, and logs why', async () => {
    const { deps: d } = deps({ send: vi.fn(async () => Promise.reject(new Error('relay down'))) });
    const res = await handleContact(post(valid, { json: true }), d);
    expect(res.status).toBe(502);
    expect(d.log).toHaveBeenCalled();
  });
});
