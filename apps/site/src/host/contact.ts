/**
 * Upgrades the contact form to submit in place. Without this script the form still works: it posts
 * to /api/contact, which answers with a redirect to the thanks page or a page listing the errors.
 */

interface Turnstile {
  reset(): void;
}
type ContactResult = { ok: true } | { ok: false; errors: Record<string, string> };

export {};

const form = document.getElementById('contact-form') as HTMLFormElement | null;
const statusLine = document.getElementById('contact-status');
const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');

function showErrors(errors: Record<string, string>): void {
  for (const slot of form?.querySelectorAll<HTMLElement>('.field-error') ?? []) {
    const name = slot.id.replace(/^contact-/, '').replace(/-error$/, '');
    const text = errors[name];
    slot.textContent = text ?? '';
    slot.hidden = !text;
    form?.querySelector(`[name="${name}"]`)?.toggleAttribute('aria-invalid', Boolean(text));
  }
  // Send keyboard and screen-reader users to the first thing to fix.
  const first = Object.keys(errors).find((name) => name !== 'form');
  form?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!statusLine || !submit) return;
  submit.disabled = true;
  statusLine.textContent = 'Sending…';
  showErrors({});

  let result: ContactResult;
  try {
    const res = await fetch(form.action, { method: 'POST', body: new FormData(form), headers: { accept: 'application/json' } });
    result = (await res.json()) as ContactResult;
  } catch {
    result = { ok: false, errors: { form: 'We couldn’t reach the server. Please check your connection and try again.' } };
  }

  if (result.ok) {
    form.replaceWith(
      Object.assign(document.createElement('p'), {
        className: 'form-sent',
        textContent: 'Thanks. Your message is on its way, and we’ll reply to the email address you gave.',
      }),
    );
    return;
  }

  showErrors(result.errors);
  statusLine.textContent = result.errors.form ?? 'Please fix the highlighted fields.';
  submit.disabled = false;
  // A Turnstile token is single-use, so every failed attempt needs a fresh check.
  (window as unknown as { turnstile?: Turnstile }).turnstile?.reset();
});
