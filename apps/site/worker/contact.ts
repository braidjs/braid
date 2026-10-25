/**
 * The contact form's endpoint, POST /api/contact.
 *
 * Kept free of Workers-only imports so it runs under plain Node in the tests: everything with a side
 * effect (rate limiting, Turnstile, sending mail, logging) comes in through `deps`.
 *
 * It answers two kinds of caller. A plain form post (no JavaScript) gets a 303 to the thanks page,
 * or a readable error page. A script that sends `Accept: application/json` gets JSON it can render
 * next to each field.
 */

export interface ContactMessage {
  name: string;
  email: string;
  company: string;
  message: string;
}

export interface ContactDeps {
  /** True while this key still has submissions left in the current window. */
  rateLimit(key: string): Promise<boolean>;
  verifyTurnstile(token: string, ip: string | null): Promise<boolean>;
  send(message: ContactMessage): Promise<void>;
  log?(message: string, detail?: unknown): void;
}

type Errors = Partial<Record<keyof ContactMessage | 'turnstile' | 'form', string>>;

const MAX_BODY_BYTES = 32 * 1024;
const MAX = { name: 100, email: 254, company: 100, message: 5000 } as const;
/** Deliberately plain: one @, no whitespace or angle brackets anywhere, a dot in the domain. */
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const THANKS_PATH = '/contact/thanks/';

export async function handleContact(request: Request, deps: ContactDeps): Promise<Response> {
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
  }

  // A browser always sends Origin on a cross-site POST; refusing a foreign one stops other sites
  // from submitting the form in a visitor's name.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return fail(wantsJson, 403, { form: 'This form can only be sent from this site.' });
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return fail(wantsJson, 413, { form: 'That message is too large to send.' });

  const ip = request.headers.get('cf-connecting-ip');
  if (!(await deps.rateLimit(ip ?? 'unknown'))) {
    const res = fail(wantsJson, 429, { form: 'That’s a lot of messages in a minute. Please wait a moment and try again.' });
    res.headers.set('retry-after', '60');
    return res;
  }

  // Read the body once and measure what actually arrived: Content-Length is optional.
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) return fail(wantsJson, 413, { form: 'That message is too large to send.' });

  let form: FormData;
  try {
    form = await new Response(raw, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData();
  } catch {
    return fail(wantsJson, 400, { form: 'We couldn’t read that form. Please try again.' });
  }
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value.trim() : '';
  };

  // The honeypot is a field people never see. Anything in it is a bot; answer as if it worked, so
  // the bot learns nothing, and send nothing.
  if (field('website')) return succeed(wantsJson);

  const message: ContactMessage = {
    name: field('name'),
    email: field('email'),
    company: field('company'),
    message: field('message'),
  };
  const errors = validate(message);
  const token = field('cf-turnstile-response');
  if (!token) errors.turnstile = 'Please complete the check that you’re a person.';
  if (Object.keys(errors).length > 0) return fail(wantsJson, 400, errors);

  if (!(await deps.verifyTurnstile(token, ip))) {
    return fail(wantsJson, 400, { turnstile: 'That check didn’t go through. Please try it again.' });
  }

  try {
    await deps.send(message);
  } catch (error) {
    deps.log?.('contact: sending the email failed', error);
    return fail(wantsJson, 502, { form: 'We couldn’t send that just now. Please try again in a few minutes.' });
  }
  return succeed(wantsJson);
}

export function validate(message: ContactMessage): Errors {
  const errors: Errors = {};
  if (!message.name) errors.name = 'Please tell us your name.';
  else if (message.name.length > MAX.name) errors.name = `Please keep your name under ${MAX.name} characters.`;

  if (!message.email) errors.email = 'Please give us an email address to reply to.';
  else if (message.email.length > MAX.email || !EMAIL.test(message.email)) errors.email = 'That email address doesn’t look right.';

  if (message.company.length > MAX.company) errors.company = `Please keep the company name under ${MAX.company} characters.`;

  if (!message.message) errors.message = 'Please tell us a little about what you need.';
  else if (message.message.length > MAX.message) errors.message = `Please keep your message under ${MAX.message.toLocaleString('en')} characters.`;
  return errors;
}

function succeed(wantsJson: boolean): Response {
  if (wantsJson) return Response.json({ ok: true });
  return new Response(null, { status: 303, headers: { location: THANKS_PATH } });
}

function fail(wantsJson: boolean, status: number, errors: Errors): Response {
  if (wantsJson) return Response.json({ ok: false, errors }, { status });
  const items = Object.values(errors)
    .map((text) => `<li>${escapeHtml(text ?? '')}</li>`)
    .join('');
  // A plain page, for a visitor without JavaScript. Their browser's back button keeps what they typed.
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Please check the form</title><link rel="stylesheet" href="/site.css"></head><body><main class="wrap" style="padding-block: 64px"><h1 style="margin: 0 0 16px; font-size: 40px; letter-spacing: -0.03em">Please check the form</h1><ul style="font-size: 18px">${items}</ul><p>Use your browser’s back button to fix it. What you typed is still there.</p></main></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
