const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Asks Cloudflare whether a Turnstile token is genuine. Any failure to get a clear yes — a network
 * error, a non-200, a malformed answer — counts as no: a spam check that fails open is not one.
 */
export async function verifyTurnstile(
  secret: string,
  token: string,
  ip: string | null,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  try {
    const res = await fetcher(SITEVERIFY, { method: 'POST', body });
    if (!res.ok) return false;
    const result = (await res.json()) as { success?: unknown };
    return result.success === true;
  } catch {
    return false;
  }
}
