// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The contact form script, run against the real form markup with fetch stubbed: what a visitor sees
 * and where focus goes for each kind of answer, including the ones that aren't our JSON.
 */

const markup = readFileSync(join(import.meta.dirname, '../pages/partials/contact.html'), 'utf8')
  .replaceAll('%BASE%', '../')
  .replaceAll('%TURNSTILE_SITEKEY%', 'test');

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function submitWith(answer: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(answer));
  const form = document.getElementById('contact-form') as HTMLFormElement;
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  // Let the fetch, the body read and the DOM updates settle.
  await vi.waitFor(() => expect(document.getElementById('contact-status')?.textContent).not.toBe('Sending…'));
}

const status = () => document.getElementById('contact-status')?.textContent;
const button = () => document.querySelector<HTMLButtonElement>('#contact-form button[type="submit"]');

beforeEach(async () => {
  document.body.innerHTML = markup;
  vi.resetModules();
  await import('./contact');
});

afterEach(() => vi.unstubAllGlobals());

describe('the contact form script', () => {
  it('marks each invalid field with aria-invalid="true", shows its message, and focuses the first', async () => {
    await submitWith(async () => json(400, { ok: false, errors: { name: 'Please tell us your name.', email: 'Bad email.' } }));
    const name = document.querySelector('[name="name"]');
    expect(name?.getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('[name="email"]')?.getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('[name="message"]')?.hasAttribute('aria-invalid')).toBe(false);
    expect(document.getElementById('contact-name-error')?.textContent).toBe('Please tell us your name.');
    expect(status()).toBe('Please fix the highlighted fields.');
    expect(document.activeElement).toBe(name);
    expect(button()?.disabled).toBe(false);
  });

  it('replaces the form with a focused confirmation on success', async () => {
    await submitWith(async () => json(200, { ok: true }));
    expect(document.getElementById('contact-form')).toBeNull();
    const sent = document.getElementById('contact-sent');
    expect(sent?.hidden).toBe(false);
    expect(document.activeElement).toBe(sent);
    expect(status()).toBe('');
  });

  it('calls a page that isn’t our JSON a server problem, not a connection problem, and frees the button', async () => {
    await submitWith(async () => new Response('<h1>502 Bad Gateway</h1>', { status: 502, headers: { 'content-type': 'text/html' } }));
    expect(status()).toMatch(/on our side/);
    expect(button()?.disabled).toBe(false);
  });

  it('copes with JSON that has no errors in it', async () => {
    await submitWith(async () => json(404, { ok: false, error: 'not found' }));
    expect(status()).toMatch(/on our side/);
    expect(button()?.disabled).toBe(false);
  });

  it('says so when the network fails', async () => {
    await submitWith(async () => Promise.reject(new TypeError('Failed to fetch')));
    expect(status()).toMatch(/check your connection/);
    expect(button()?.disabled).toBe(false);
  });

  it('puts a Turnstile-only failure in the status line, where it will be announced', async () => {
    const reset = vi.fn();
    vi.stubGlobal('turnstile', { reset });
    await submitWith(async () => json(400, { ok: false, errors: { turnstile: 'That check didn’t go through.' } }));
    expect(status()).toBe('That check didn’t go through.');
    expect(reset).toHaveBeenCalled();
  });
});
