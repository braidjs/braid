/**
 * Where the workspace keeps what it remembers for a user: intent choices, host preferences, each
 * app's settings and saved layouts. Values are JSON; keys are `/`-separated paths such as
 * `apps/billing/theme` (see {@link isStoreKey}).
 *
 * Two are provided, and any other storage can implement the interface:
 *
 * - {@link localStorageStore} — in the browser, for this origin and browser profile.
 * - {@link serverStore} — on the gateway (`createGateway({ preferences })`), keyed by the
 *   signed-in user, so it follows them to any browser.
 */
export interface PreferenceStore {
  /** The value, or undefined when there is none. */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys that start with `prefix`, sorted. */
  list(prefix: string): Promise<string[]>;
}

const SEGMENT = /^[A-Za-z0-9._~%-]{1,128}$/;

/**
 * Whether `key` can be stored: up to 512 characters in at most eight `/`-separated segments of
 * `A-Z a-z 0-9 . _ ~ % -`, none of them `.` or `..`. The gateway checks the same rule.
 */
export function isStoreKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  const segments = key.split('/');
  return segments.length <= 8 && segments.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..');
}

/** A segment for a store key from any string — a layout's name, an intent, an app id. */
export function keySegment(value: string): string {
  // encodeURIComponent leaves only A-Z a-z 0-9 - _ . ! ~ * ' ( ) unescaped; escape the rest of those too
  const encoded = encodeURIComponent(value).replace(/[!*'()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return encoded === '.' ? '%2E' : encoded === '..' ? '%2E%2E' : encoded || '%00';
}

function checkKey(key: string): void {
  if (!isStoreKey(key)) throw new TypeError(`braid-workspace: "${key}" is not a store key`);
}

/** A JSON round trip: what a store holds is data, never a live object shared with the caller. */
function toJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('braid-workspace: a stored value must be JSON');
  return json;
}

/** Entries in memory, gone on reload. For tests, and where nothing should persist. */
export function memoryStore(): PreferenceStore {
  const entries = new Map<string, string>();
  return {
    async get(key) {
      checkKey(key);
      const json = entries.get(key);
      return json === undefined ? undefined : JSON.parse(json);
    },
    async set(key, value) {
      checkKey(key);
      entries.set(key, toJson(value));
    },
    async delete(key) {
      checkKey(key);
      entries.delete(key);
    },
    async list(prefix) {
      return [...entries.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
  };
}

export interface LocalStorageStoreOptions {
  /** Prepended to every key in `localStorage`, so the workspace's entries stay apart from the page's. Defaults to `braid.workspace/`. */
  prefix?: string;
  /** Defaults to `localStorage`. */
  storage?: Storage;
}

/**
 * Entries in `localStorage`: per origin and browser profile, kept across reloads. Where
 * `localStorage` is unavailable (blocked, or not a browser) it keeps them in memory instead, so a
 * page never fails to compose over its preferences.
 */
export function localStorageStore(options: LocalStorageStoreOptions = {}): PreferenceStore {
  const prefix = options.prefix ?? 'braid.workspace/';
  let storage: Storage | undefined;
  try {
    storage = options.storage ?? globalThis.localStorage;
  } catch {
    // reading localStorage throws a SecurityError where storage is blocked
  }
  if (!storage) return memoryStore();
  const local = storage;
  return {
    async get(key) {
      checkKey(key);
      const json = local.getItem(prefix + key);
      if (json === null) return undefined;
      try {
        return JSON.parse(json);
      } catch {
        // someone else's write under our prefix: not ours to interpret
        return undefined;
      }
    },
    async set(key, value) {
      checkKey(key);
      local.setItem(prefix + key, toJson(value));
    },
    async delete(key) {
      checkKey(key);
      local.removeItem(prefix + key);
    },
    async list(keyPrefix) {
      const keys: string[] = [];
      for (let index = 0; index < local.length; index++) {
        const name = local.key(index);
        if (name?.startsWith(prefix + keyPrefix) && isStoreKey(name.slice(prefix.length))) keys.push(name.slice(prefix.length));
      }
      return keys.sort();
    },
  };
}

export interface ServerStoreOptions {
  /** The gateway's preferences endpoint. Defaults to `/__braid/preferences`. */
  url?: string;
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/**
 * Entries on the gateway (`createGateway({ preferences })`), keyed by the signed-in user: they
 * follow the user to any browser. Requests carry the page's cookies (`credentials: 'same-origin'`);
 * a failed request rejects with the status, so the caller sees it rather than silently losing a
 * write.
 */
export function serverStore(options: ServerStoreOptions = {}): PreferenceStore {
  const base = (options.url ?? '/__braid/preferences').replace(/\/+$/, '');
  const send = (input: string, init: RequestInit = {}) =>
    (options.fetch ?? globalThis.fetch)(input, { credentials: 'same-origin', cache: 'no-store', ...init });
  const url = (key: string) => {
    checkKey(key);
    return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  };
  async function ok(response: Response, what: string): Promise<Response> {
    if (!response.ok) throw new Error(`braid-workspace: ${what} failed with ${response.status}`);
    return response;
  }
  return {
    async get(key) {
      const response = await send(url(key), { headers: { accept: 'application/json' } });
      if (response.status === 404) return undefined;
      return (await ok(response, `reading "${key}"`)).json();
    },
    async set(key, value) {
      await ok(
        await send(url(key), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: toJson(value) }),
        `writing "${key}"`,
      );
    },
    async delete(key) {
      await ok(await send(url(key), { method: 'DELETE' }), `deleting "${key}"`);
    },
    async list(prefix) {
      const response = await ok(await send(`${base}?prefix=${encodeURIComponent(prefix)}`), `listing "${prefix}"`);
      const { keys } = (await response.json()) as { keys?: unknown };
      return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string').sort() : [];
    },
  };
}
