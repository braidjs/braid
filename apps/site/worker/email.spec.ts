import { describe, expect, it, vi } from 'vitest';
import { buildEmail } from './email';
import { verifyTurnstile } from './turnstile';

const message = { name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical Engines', message: 'Hello — café ☕' };
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

  it('encodes the subject, so a line break in a name cannot add a header', () => {
    const hostile = buildEmail({
      from: 'site@braid.example',
      to: 'me@braid.example',
      message: { ...message, name: 'Eve\r\nBcc: everyone@evil.test' },
    });
    const headers = hostile.split('\r\n\r\n')[0] ?? '';
    expect(headers).not.toMatch(/^Bcc:/m);
    const subject = headers.match(/^Subject: =\?UTF-8\?B\?([^?]+)\?=$/m)?.[1] ?? '';
    expect(decode(subject)).toBe('Hosted Braid enquiry from Eve Bcc: everyone@evil.test (Analytical Engines)');
  });
});

describe('verifyTurnstile', () => {
  const answer = (status: number, json: unknown) => vi.fn(async () => new Response(JSON.stringify(json), { status }));

  it('is true only for a 200 that says success: true, and sends the secret, token and IP', async () => {
    const fetcher = answer(200, { success: true });
    expect(await verifyTurnstile('s3cret', 'tok', '203.0.113.7', fetcher)).toBe(true);
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toBe('secret=s3cret&response=tok&remoteip=203.0.113.7');
  });

  it.each([
    ['a failed check', answer(200, { success: false })],
    ['a non-200', answer(500, { success: true })],
    ['a malformed answer', answer(200, { ok: 'yes' })],
    ['a network error', vi.fn(async () => Promise.reject(new Error('offline')))],
  ])('fails closed on %s', async (_label, fetcher) => {
    expect(await verifyTurnstile('s', 't', null, fetcher as unknown as typeof fetch)).toBe(false);
  });
});
