/**
 * The contact form's endpoint, POST /api/contact.
 *
 * Platform-neutral: it takes a standard Request and returns a Response, and everything with a side
 * effect or a platform-specific source (the client IP, rate limiting, Turnstile, sending mail,
 * logging) comes in through `deps`. So the same handler runs in a Cloudflare Worker, an AWS Lambda,
 * or under plain Node in the tests.
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
  /** The visitor's IP as the platform's edge reports it, or null when it can't say. */
  clientIp(request: Request): string | null;
  /** True while this key still has submissions left in the current window. */
  rateLimit(key: string): Promise<boolean>;
  verifyTurnstile(token: string, ip: string | null): Promise<boolean>;
  send(message: ContactMessage): Promise<void>;
  log?(message: string, detail?: unknown): void;
}

type Errors = Partial<Record<keyof ContactMessage | 'turnstile' | 'form', string>>;

const MAX_BODY_BYTES = 32 * 1024;
const MAX = { name: 100, email: 254, company: 100, message: 5000 } as const;
/**
 * An allowlist, not a parser: letters, digits and `._%+-` before the @, a dotted domain after. It
 * keeps out everything RFC 5322 gives meaning to in an address header (commas, semicolons, quotes,
 * parentheses, brackets, control characters), so Reply-To is always exactly one plain address.
 */
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
/** The honeypot's field name: deliberately not one a browser or password manager would autofill. */
export const HONEYPOT = 'hp_extra';
export const THANKS_PATH = '/contact/thanks/';

/** Set on every response the endpoint makes; static-asset headers don't reach generated ones. */
const BASE_HEADERS = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
const ERROR_PAGE_CSP =
  "default-src 'none'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export async function handleContact(request: Request, deps: ContactDeps): Promise<Response> {
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');

  if (request.method !== 'POST') {
    const res = fail(wantsJson, 405, { form: 'This address only accepts the contact form.' });
    res.headers.set('allow', 'POST');
    return res;
  }

  // A browser always sends Origin on a cross-site POST; refusing a foreign one stops other sites
  // from submitting the form in a visitor's name.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return fail(wantsJson, 403, { form: 'This form can only be sent from this site.' });
  }

  const raw = await readCapped(request, MAX_BODY_BYTES);
  if (!raw) return fail(wantsJson, 413, { form: 'That message is too large to send.' });

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
  // Logged (without its content), so a real visitor whose browser autofilled it isn't lost unseen.
  if (field(HONEYPOT)) {
    deps.log?.('contact: honeypot filled; dropped');
    return succeed(wantsJson);
  }

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

  // Only submissions that could actually be sent count against the limit, so a visitor fixing a
  // typo doesn't lock themselves out. With no IP to key on, refuse rather than share one bucket.
  const ip = deps.clientIp(request);
  if (!ip) return fail(wantsJson, 400, { form: 'We couldn’t tell where this came from, so we didn’t send it.' });
  if (!(await deps.rateLimit(ip))) {
    const res = fail(wantsJson, 429, { form: 'That’s a lot of messages in a minute. Please wait a moment and try again.' });
    res.headers.set('retry-after', '60');
    return res;
  }

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

/**
 * Reads the body, but stops — and cancels the rest — as soon as it passes `limit` bytes, so a huge
 * body (with or without Content-Length) never gets buffered. Null means it was too large.
 */
async function readCapped(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(request.headers.get('content-length') ?? '0') > limit) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function succeed(wantsJson: boolean): Response {
  if (wantsJson) return Response.json({ ok: true }, { headers: BASE_HEADERS });
  return new Response(null, { status: 303, headers: { ...BASE_HEADERS, location: THANKS_PATH } });
}

function fail(wantsJson: boolean, status: number, errors: Errors): Response {
  if (wantsJson) return Response.json({ ok: false, errors }, { status, headers: BASE_HEADERS });
  const items = Object.values(errors)
    .map((text) => `<li>${escapeHtml(text ?? '')}</li>`)
    .join('');
  // A plain page, for a visitor without JavaScript. Their browser's back button keeps what they typed.
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Please check the form</title><link rel="stylesheet" href="/site.css"></head><body><main class="wrap" style="padding-block: 64px"><h1 style="margin: 0 0 16px; font-size: 40px; letter-spacing: -0.03em">Please check the form</h1><ul style="font-size: 18px">${items}</ul><p>Use your browser’s back button to fix it. What you typed is still there.</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': ERROR_PAGE_CSP },
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
