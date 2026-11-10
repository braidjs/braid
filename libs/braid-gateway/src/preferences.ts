import type { Principal } from './registry.js';

/**
 * Per-user preferences, served by the gateway for `@braidlabs/fdc3`'s `serverStore`: an FDC3
 * page's remembered intent choices, each app's settings and its saved layouts.
 *
 * The gateway already resolves who is asking (its `principal` option), so it is the natural place
 * to keep what belongs to that person. Each entry is keyed by the principal's `subject` and a
 * key; nothing in a request can name another subject, so one user can never read or write
 * another's entries. Values are JSON, stored as text — a backend never has to understand them.
 *
 * ```
 * GET    /__braid/preferences/{key}           → 200 the value, or 404
 * PUT    /__braid/preferences/{key}           ← the value, as application/json → 204
 * DELETE /__braid/preferences/{key}           → 204
 * GET    /__braid/preferences?prefix={prefix} → 200 { "keys": [...] }
 * ```
 *
 * A key is up to eight `/`-separated segments of `A-Z a-z 0-9 . _ ~ % -`, each percent-encoded in
 * the URL. Writes are refused cross-site: a write must send `application/json` (which a form
 * cannot, and which a cross-origin `fetch` must preflight) and, where the browser says where it
 * came from, come from the same origin.
 */
export interface PreferencesOptions {
  /** Where entries are kept. `memoryPreferenceBackend()` for tests; `filePreferenceBackend()` from `@braidlabs/gateway/node`. */
  backend: PreferenceBackend;
  /** Defaults to `/__braid/preferences`. */
  path?: string;
  /** The largest value accepted, in bytes of JSON. Defaults to 64 KiB. */
  maxValueBytes?: number;
  /** How many entries one subject may hold. Defaults to 1000. */
  maxEntries?: number;
  /** How many bytes of JSON one subject may hold in all, keys included. Defaults to 1 MiB. */
  maxTotalBytes?: number;
}

/** What one subject may hold; a backend enforces it as part of the write it guards. */
export interface PreferenceLimits {
  maxEntries: number;
  maxTotalBytes: number;
}

/** Thrown by a backend's `set` when the write would take the subject past its {@link PreferenceLimits}. */
export class PreferenceQuotaError extends Error {
  constructor(message = 'preference quota exceeded') {
    super(message);
    this.name = 'PreferenceQuotaError';
  }
}

/**
 * Storage for preferences, by subject. Values are JSON text; keys are already validated.
 *
 * `set` must check `limits` and write as one step — inside the same lock or transaction — so that
 * concurrent writes cannot each pass the check and together exceed it; see {@link withinLimits}.
 */
export interface PreferenceBackend {
  get(subject: string, key: string): Promise<string | undefined>;
  /** Rejects with {@link PreferenceQuotaError} when the write would exceed `limits`. */
  set(subject: string, key: string, json: string, limits: PreferenceLimits): Promise<void>;
  delete(subject: string, key: string): Promise<void>;
  /** The subject's keys that start with `prefix`, in any order. */
  list(subject: string, prefix: string): Promise<string[]>;
}

export const DEFAULT_PREFERENCES_PATH = '/__braid/preferences';
const DEFAULT_MAX_VALUE_BYTES = 64 * 1024;
const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_KEY_LENGTH = 512;
const MAX_SEGMENTS = 8;
const SEGMENT = /^[A-Za-z0-9._~%-]{1,128}$/;

/** Whether `key` is a preference key: see {@link PreferencesOptions}. */
export function isPreferenceKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  const segments = key.split('/');
  return segments.length <= MAX_SEGMENTS && segments.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..');
}

/**
 * Whether a subject's entries, with `key` set to `json`, stay within `limits`. For backends: call it
 * on the entries as they are inside the write's critical section.
 */
export function withinLimits(entries: Iterable<[string, string]>, key: string, json: string, limits: PreferenceLimits): boolean {
  let count = 0;
  let bytes = 0;
  for (const [existing, value] of entries) {
    if (existing === key) continue;
    count++;
    bytes += existing.length + value.length;
  }
  return count + 1 <= limits.maxEntries && bytes + key.length + json.length <= limits.maxTotalBytes;
}

/** Entries in memory, gone when the process exits. For tests and single-process development. */
export function memoryPreferenceBackend(): PreferenceBackend {
  const subjects = new Map<string, Map<string, string>>();
  const entries = (subject: string) => {
    let map = subjects.get(subject);
    if (!map) subjects.set(subject, (map = new Map()));
    return map;
  };
  return {
    async get(subject, key) {
      return subjects.get(subject)?.get(key);
    },
    async set(subject, key, json, limits) {
      // synchronous from check to write, so nothing can interleave
      const map = entries(subject);
      if (!withinLimits(map, key, json, limits)) throw new PreferenceQuotaError();
      map.set(key, json);
    },
    async delete(subject, key) {
      subjects.get(subject)?.delete(key);
    },
    async list(subject, prefix) {
      return [...(subjects.get(subject)?.keys() ?? [])].filter((key) => key.startsWith(prefix));
    },
  };
}

export interface PreferencesHandler {
  owns(pathname: string): boolean;
  handle(request: Request, url: URL): Promise<Response>;
}

export function createPreferencesHandler(
  options: PreferencesOptions | undefined,
  resolvePrincipal: (request: Request) => Promise<Principal | undefined>,
): PreferencesHandler | null {
  if (!options) return null;
  const path = (options.path ?? DEFAULT_PREFERENCES_PATH).replace(/\/+$/, '');
  // a root path, or a relative one, would claim every request the gateway sees
  if (!path.startsWith('/') || path === '' || path.includes('//')) {
    throw new Error(`braid-gateway: preferences.path "${options.path}" must be an absolute path such as "${DEFAULT_PREFERENCES_PATH}"`);
  }
  const maxValueBytes = options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
  const limits: PreferenceLimits = {
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  };
  const { backend } = options;

  return {
    owns(pathname) {
      return pathname === path || pathname.startsWith(`${path}/`);
    },

    async handle(request, url) {
      // nothing here is for another site, reads included: they would only tell it what exists
      if (crossSite(request, url)) return json({ error: 'cross-site requests are refused' }, 403);
      let subject: unknown;
      try {
        subject = (await resolvePrincipal(request))?.subject;
      } catch (error) {
        console.error('braid-gateway: the principal resolver failed for a preferences request', error);
        return json({ error: 'preferences are unavailable' }, 500);
      }
      if (typeof subject !== 'string' || subject.length === 0) return json({ error: 'sign in to use preferences' }, 401);

      const rest = url.pathname.slice(path.length);
      try {
        if (rest === '' || rest === '/') {
          if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, { Allow: 'GET' });
          const prefix = url.searchParams.get('prefix') ?? '';
          if (prefix !== '' && !isPreferenceKey(prefix.replace(/\/$/, ''))) return json({ error: 'malformed prefix' }, 400);
          return json({ keys: (await backend.list(subject, prefix)).sort() }, 200);
        }

        const key = decodeKey(rest.slice(1));
        if (key === undefined) return json({ error: 'malformed key' }, 400);

        if (request.method === 'GET') {
          const value = await backend.get(subject, key);
          return value === undefined ? json({ error: 'not found' }, 404) : text(value, 200);
        }
        if (request.method !== 'PUT' && request.method !== 'DELETE') {
          return json({ error: 'method not allowed' }, 405, { Allow: 'GET, PUT, DELETE' });
        }
        if (request.method === 'DELETE') {
          await backend.delete(subject, key);
          return new Response(null, { status: 204, headers: NO_STORE });
        }

        if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) {
          return json({ error: 'send the value as application/json' }, 415);
        }
        const body = await readLimited(request, maxValueBytes);
        if (body === undefined) return json({ error: `values are limited to ${maxValueBytes} bytes` }, 413);
        let value: unknown;
        try {
          value = JSON.parse(body);
        } catch {
          return json({ error: 'the value is not JSON' }, 400);
        }
        await backend.set(subject, key, JSON.stringify(value), limits);
        return new Response(null, { status: 204, headers: NO_STORE });
      } catch (error) {
        if (error instanceof PreferenceQuotaError || (error as Error | undefined)?.name === 'PreferenceQuotaError') {
          return json({ error: `at most ${limits.maxEntries} preferences, ${limits.maxTotalBytes} bytes in all, per user` }, 413);
        }
        console.error('braid-gateway: preferences backend failed', error);
        return json({ error: 'preferences are unavailable' }, 500);
      }
    },
  };
}

/** Each segment percent-decoded, then the whole checked; undefined if it is not a key. */
function decodeKey(raw: string): string | undefined {
  try {
    const key = raw.split('/').map(decodeURIComponent).join('/');
    return isPreferenceKey(key) && key.split('/').length === raw.split('/').length ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A request the browser says came from another origin: by `Sec-Fetch-Site` where it sends one, and
 * otherwise by `Origin`, which every browser sends on a PUT or DELETE. Neither header (a non-browser
 * client, or a same-origin GET in an older browser) is not cross-site.
 */
function crossSite(request: Request, url: URL): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) return site !== 'same-origin' && site !== 'none';
  const origin = request.headers.get('origin');
  return origin !== null && origin !== url.origin;
}

/** The body as text, or undefined once it passes `limit` bytes — without reading the rest. */
async function readLimited(request: Request, limit: number): Promise<string | undefined> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return undefined;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** A person's own data: never in a shared cache, never kept by the browser either. */
const NO_STORE = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return text(JSON.stringify(body), status, headers);
}

function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json', ...NO_STORE, ...headers } });
}
