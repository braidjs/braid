import { describe, expect, it, vi } from 'vitest';
import { buildEmail } from './email';
import { verifyTurnstile } from './turnstile';

const message = { name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical Engines', message: 'Hello — café ☕' };
/** Joins a folded Subject's encoded-words back into its text. */
const decodeSubject = (headers: string) => {
  const folded = headers.match(/^Subject: ([\s\S]*?)\r\n(?! )/m)?.[1] ?? '';
  const bytes = [...folded.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].flatMap((m) => [...atob(m[1] ?? '')].map((c) => c.charCodeAt(0)));
  return new TextDecoder().decode(Uint8Array.from(bytes));
};
const decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\r\n/g, '')), (c) => c.charCodeAt(0)));

describe('buildEmail', () => {
  const raw = buildEmail({ from: 'site@braid.example', to: 'me@braid.example', message, now: new Date(0), id: 'fixed' });
  const [head = '', body = ''] = raw.split('\r\n\r\n');

  it('addresses it to you, from the site, with Reply-To set to the visitor', () => {
    expect(head).toContain('From: Braid site <site@braid.example>');
    expect(head).toContain('To: me@braid.example');
    expect(head).toContain('Reply-To: ada@example.com');
    expect(head).toContain('Message-ID: <fixed@braid.example>');
  });

  it('carries every field, in UTF-8, in the body', () => {
    const text = decode(body);
    for (const part of ['Ada Lovelace', 'ada@example.com', 'Analytical Engines', 'Hello — café ☕']) expect(text).toContain(part);
  });

  it('keeps a line break in the name from faking another line in the body', () => {
    const raw2 = buildEmail({ from: 'site@braid.example', to: 'me@braid.example', message: { ...message, name: 'Eve\r\nEmail: ceo@braid.example' } });
    const text = decode(raw2.split('\r\n\r\n')[1] ?? '');
    expect(text).toContain('Name:    Eve Email: ceo@braid.example');
    expect(text.match(/^Email:/gm)).toHaveLength(1);
  });

  it('encodes the subject, so a line break in a name cannot add a header', () => {
    const hostile = buildEmail({
      from: 'site@braid.example',
      to: 'me@braid.example',
      message: { ...message, name: 'Eve\r\nBcc: everyone@evil.test' },
    });
    const headers = hostile.split('\r\n\r\n')[0] ?? '';
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(decodeSubject(headers)).toBe('Hosted Braid enquiry from Eve Bcc: everyone@evil.test (Analytical Engines)');
  });

  it('folds a long subject so every header line stays under 78 characters, and decodes intact', () => {
    const name = '名前'.repeat(50); // 100 characters, 300 bytes
    const company = 'Ü'.repeat(100);
    const long = buildEmail({ from: 'site@braid.example', to: 'me@braid.example', message: { ...message, name, company } });
    const headers = long.split('\r\n\r\n')[0] ?? '';
    for (const line of headers.split('\r\n')) expect(line.length, line).toBeLessThanOrEqual(78);
    for (const word of headers.match(/=\?UTF-8\?B\?[^?]+\?=/g) ?? []) expect(word.length).toBeLessThanOrEqual(75);
    expect(decodeSubject(headers)).toBe(`Hosted Braid enquiry from ${name} (${company})`);
  });

  it('dates the message with a numeric zone', () => {
    expect(head).toContain('Date: Thu, 01 Jan 1970 00:00:00 +0000');
  });
});

describe('verifyTurnstile', () => {
  const answer = (status: number, json: unknown) => vi.fn(async () => new Response(JSON.stringify(json), { status }));

  it('is true only for a 200 that says success: true, and sends the secret, token and IP', async () => {
    const fetcher = answer(200, { success: true });
    expect(await verifyTurnstile('s3cret', 'tok', '203.0.113.7', { fetcher })).toBe(true);
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toBe('secret=s3cret&response=tok&remoteip=203.0.113.7');
  });

  it('checks hostname and action when they are configured, which also catches test keys in production', async () => {
    const expect_ = { hostname: 'braid.example', action: 'contact' };
    const good = answer(200, { success: true, hostname: 'braid.example', action: 'contact' });
    expect(await verifyTurnstile('s', 't', null, { fetcher: good, expected: expect_ })).toBe(true);
    // Cloudflare's test keys answer with hostname "example.com".
    expect(await verifyTurnstile('s', 't', null, { fetcher: answer(200, { success: true, hostname: 'example.com', action: 'contact' }), expected: expect_ })).toBe(false);
    expect(await verifyTurnstile('s', 't', null, { fetcher: answer(200, { success: true, hostname: 'braid.example', action: 'other' }), expected: expect_ })).toBe(false);
  });

  it('logs why a token was refused, so a misconfigured secret is visible', async () => {
    const log = vi.fn();
    await verifyTurnstile('s', 't', null, { fetcher: answer(200, { success: false, 'error-codes': ['invalid-input-secret'] }), log });
    expect(log).toHaveBeenCalledWith('turnstile: token refused', ['invalid-input-secret']);
  });

  it('gives up after a timeout rather than hanging the request', async () => {
    const fetcher = answer(200, { success: true });
    await verifyTurnstile('s', 't', null, { fetcher });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['a failed check', answer(200, { success: false })],
    ['a non-200', answer(500, { success: true })],
    ['a malformed answer', answer(200, { ok: 'yes' })],
    ['a network error', vi.fn(async () => Promise.reject(new Error('offline')))],
  ])('fails closed on %s', async (_label, fetcher) => {
    expect(await verifyTurnstile('s', 't', null, { fetcher: fetcher as unknown as typeof fetch })).toBe(false);
  });
});
