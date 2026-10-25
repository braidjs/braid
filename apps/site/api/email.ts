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
    'A visitor typed this into the contact form on the Braid site. Nothing in it is verified, so check before you act on any links.',
    '',
    `Name:    ${oneLine(message.name)}`,
    `Email:   ${message.email}`,
    `Company: ${oneLine(message.company) || '—'}`,
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
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${rfc5322Date(now)}`,
    `Message-ID: <${id}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    // Canonical line endings before encoding: a textarea can send bare \n.
    wrap(base64(body.replace(/\r?\n/g, '\r\n'))),
  ].join('\r\n');
}

/** Collapses any run of whitespace, line breaks included, to one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * A header value as RFC 2047 encoded-words: safe for any characters, and never a raw line break.
 *
 * Each word carries at most 39 bytes: 52 base64 characters, 64 with its `=?UTF-8?B?…?=` frame. That
 * is within the 75 the RFC allows, and 73 on the first line after "Subject: ". Words split on
 * code-point boundaries, so no character is cut in half, and fold onto continuation lines, so every
 * header line stays under 78 characters however long the visitor's name is.
 */
function encodeHeader(text: string): string {
  const encoder = new TextEncoder();
  const words: string[] = [];
  let chunk = '';
  for (const char of text) {
    if (encoder.encode(chunk + char).byteLength > 39) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${base64(word)}?=`).join('\r\n ');
}

/** RFC 5322 date with a numeric zone (`+0000`), not the obsolete `GMT`. */
function rfc5322Date(date: Date): string {
  return date.toUTCString().replace(/GMT$/, '+0000');
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
