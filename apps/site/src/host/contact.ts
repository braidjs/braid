/**
 * Upgrades the contact form to submit in place, with errors next to each field.
 *
 * Without this script the form still posts to /api/contact, which answers with a redirect to the
 * thanks page or a page listing the errors. (The Turnstile check itself needs JavaScript, so a visitor
 * with it turned off is told so by the page's <noscript> note.)
 */

export {};

interface Turnstile {
  reset(): void;
}
type Errors = Record<string, string>;

const form = document.getElementById('contact-form') as HTMLFormElement | null;
// Both live outside the form, so they survive it being replaced on success.
const statusLine = document.getElementById('contact-status');
const sent = document.getElementById('contact-sent');
const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');

const NETWORK = 'We couldn’t reach the server. Please check your connection and try again.';
const SERVER = 'Something went wrong on our side. Please try again in a few minutes.';

function showErrors(errors: Errors): void {
  for (const slot of form?.querySelectorAll<HTMLElement>('.field-error') ?? []) {
    const name = slot.id.replace(/^contact-/, '').replace(/-error$/, '');
    const text = errors[name];
    slot.textContent = text ?? '';
    slot.hidden = !text;
    const input = form?.querySelector(`[name="${name}"]`);
    if (text) input?.setAttribute('aria-invalid', 'true');
    else input?.removeAttribute('aria-invalid');
  }
}

/** Posts the form and turns any answer, or none, into either success or a set of errors. */
async function send(target: HTMLFormElement): Promise<{ ok: true } | { ok: false; errors: Errors }> {
  let res: Response;
  try {
    res = await fetch(target.action, { method: 'POST', body: new FormData(target), headers: { accept: 'application/json' } });
  } catch {
    return { ok: false, errors: { form: NETWORK } };
  }
  // An edge error page, a proxy's 502, anything that isn't our JSON: say it's on our side.
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return { ok: false, errors: { form: SERVER } };
  let body: { ok?: unknown; errors?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, errors: { form: SERVER } };
  }
  if (res.ok && body.ok === true) return { ok: true };
  const errors = body.errors && typeof body.errors === 'object' ? (body.errors as Errors) : {};
  return { ok: false, errors: Object.keys(errors).length ? errors : { form: SERVER } };
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!statusLine || !submit) return;
  submit.disabled = true;
  statusLine.textContent = 'Sending…';
  showErrors({});

  let succeeded = false;
  try {
    const result = await send(form);
    if (result.ok) {
      succeeded = true;
      form.remove();
      statusLine.textContent = '';
      if (sent) {
        sent.hidden = false;
        // Focus the confirmation so keyboard and screen-reader users land on it.
        sent.focus();
      }
      return;
    }
    showErrors(result.errors);
    const fields = Object.keys(result.errors).filter((name) => name !== 'form' && name !== 'turnstile');
    statusLine.textContent =
      result.errors['form'] ?? (fields.length ? 'Please fix the highlighted fields.' : result.errors['turnstile'] ?? SERVER);
    // Send keyboard and screen-reader users to the first thing to fix.
    if (fields[0]) form.querySelector<HTMLElement>(`[name="${fields[0]}"]`)?.focus();
    // A Turnstile token is single-use, so every failed attempt needs a fresh check.
    (window as unknown as { turnstile?: Turnstile }).turnstile?.reset();
  } finally {
    if (!succeeded) submit.disabled = false;
  }
});
