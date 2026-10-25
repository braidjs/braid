const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5000;

/** What a genuine token for this form must also say about itself, when configured. */
export interface TurnstileExpectations {
  /** The site's hostname. Also catches Cloudflare's test keys in production: they report example.com. */
  hostname?: string;
  /** The widget's data-action. */
  action?: string;
}

export interface VerifyOptions {
  fetcher?: typeof fetch;
  expected?: TurnstileExpectations;
  /** Told why a token was refused (Cloudflare's error codes; no personal data), so failures are visible. */
  log?: (message: string, detail?: unknown) => void;
}

/**
 * Asks Cloudflare whether a Turnstile token is genuine. Any failure to get a clear yes — a network
 * error, a timeout, a non-200, a malformed answer, the wrong hostname or action — counts as no: a
 * spam check that fails open is not one. Siteverify itself refuses a token it has seen before.
 */
export async function verifyTurnstile(
  secret: string,
  token: string,
  ip: string | null,
  { fetcher = fetch, expected = {}, log }: VerifyOptions = {},
): Promise<boolean> {
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  try {
    const res = await fetcher(SITEVERIFY, { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      log?.('turnstile: siteverify answered', res.status);
      return false;
    }
    const result = (await res.json()) as { success?: unknown; hostname?: unknown; action?: unknown; 'error-codes'?: unknown };
    if (result.success !== true) {
      log?.('turnstile: token refused', result['error-codes']);
      return false;
    }
    if (expected.hostname !== undefined && result.hostname !== expected.hostname) {
      log?.('turnstile: token was issued for another hostname', result.hostname);
      return false;
    }
    if (expected.action !== undefined && result.action !== expected.action) {
      log?.('turnstile: token was issued for another action', result.action);
      return false;
    }
    return true;
  } catch (error) {
    log?.('turnstile: siteverify failed', error instanceof Error ? error.message : error);
    return false;
  }
}
