import type { ContactMessage } from './contact';

/**
 * Builds the raw RFC 5322 message Cloudflare's `send_email` binding takes.
 *
 * Nothing the visitor typed goes into a header verbatim. The subject is RFC 2047-encoded, so a line
 * break in a name cannot start a new header. Reply-To carries the email address, which `validate()`
 * has already checked has no whitespace or angle brackets. Everything else goes in the body.
 */
export function buildEmail(options: {
  from: string;
  to: string;
  message: ContactMessage;
  now?: Date;
  id?: string;
}): string {
  const { from, to, message } = options;
  const now = options.now ?? new Date();
  const id = options.id ?? crypto.randomUUID();
  const domain = from.split('@')[1] ?? 'localhost';

  const subject = `Hosted Braid enquiry from ${oneLine(message.name)}${message.company ? ` (${oneLine(message.company)})` : ''}`;
  const body = [
    `Name:    ${message.name}`,
    `Email:   ${message.email}`,
    `Company: ${message.company || '—'}`,
    '',
    message.message,
    '',
    '—',
    'Sent from the contact form on the Braid site. Reply to this email to answer them.',
  ].join('\r\n');

  return [
    `From: Braid site <${from}>`,
    `To: ${to}`,
    `Reply-To: ${message.email}`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${id}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(base64(body)),
  ].join('\r\n');
}

/** Collapses any run of whitespace, line breaks included, to one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** RFC 2047 encoded-word: safe for any characters, and it can never contain a line break. */
function encodeWord(text: string): string {
  return `=?UTF-8?B?${base64(text)}?=`;
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Base64 bodies wrap at 76 characters per line. */
function wrap(text: string): string {
  return text.match(/.{1,76}/g)?.join('\r\n') ?? '';
}
