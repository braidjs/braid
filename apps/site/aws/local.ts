import { handleContact } from '../api/contact';
import { buildEmail } from '../api/email';
import { verifyTurnstile } from '../api/turnstile';

/**
 * The contact handler for local development (`npx nx run site:dev`): the same code the Lambda runs,
 * with stand-ins for AWS. Rate limiting is in memory, Turnstile uses Cloudflare's published
 * always-pass test secret, and the email that would be sent is printed instead.
 */

const TEST_SECRET = '1x0000000000000000000000000000000AA';
const hits = new Map<string, number>();

export function handle(request: Request): Promise<Response> {
  return handleContact(request, {
    clientIp: (req) => req.headers.get('x-dev-client-ip'),
    async rateLimit(ip) {
      const key = `${ip}#${Math.floor(Date.now() / 60_000)}`;
      const count = (hits.get(key) ?? 0) + 1;
      hits.set(key, count);
      return count <= 5;
    },
    verifyTurnstile: (token, ip) => verifyTurnstile(TEST_SECRET, token, ip, { log: console.error }),
    async send(message) {
      const raw = buildEmail({ from: 'site@localhost', to: 'team@localhost', message });
      const [head = '', body = ''] = raw.split('\r\n\r\n');
      const text = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8');
      console.log(`\n— email that would be sent —\n${head}\n\n${text}\n— end —\n`);
    },
    log: console.error,
  });
}
