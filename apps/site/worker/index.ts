import { EmailMessage } from 'cloudflare:email';
import { handleContact } from './contact';
import { buildEmail } from './email';
import { verifyTurnstile } from './turnstile';

/**
 * The Worker. It runs for /api/* only (`run_worker_first` in wrangler.jsonc). Every page, script
 * and fragment is served straight from static assets with no code involved, so "there's no server
 * behind it" stays true of the page; the Worker exists for the contact form.
 */

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  EMAIL: { send(message: EmailMessage): Promise<void> };
  CONTACT_LIMIT: { limit(options: { key: string }): Promise<{ success: boolean }> };
  TURNSTILE_SECRET: string;
  CONTACT_TO: string;
  CONTACT_FROM: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/contact') {
      return handleContact(request, {
        rateLimit: async (key) => (await env.CONTACT_LIMIT.limit({ key })).success,
        verifyTurnstile: (token, ip) => verifyTurnstile(env.TURNSTILE_SECRET, token, ip),
        send: async (message) => {
          const raw = buildEmail({ from: env.CONTACT_FROM, to: env.CONTACT_TO, message });
          await env.EMAIL.send(new EmailMessage(env.CONTACT_FROM, env.CONTACT_TO, raw));
        },
        log: (text, detail) => console.error(text, detail),
      });
    }
    if (pathname.startsWith('/api/')) return Response.json({ ok: false, error: 'not found' }, { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
