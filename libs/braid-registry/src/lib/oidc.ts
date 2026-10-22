import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import type { AuthorizeResult, RegistryAction } from './api.js';
import type { OwnedTags } from './ownership.js';

/**
 * `authorize` and `identify` for the registry API, from an OIDC provider's access tokens — Okta,
 * or any issuer that publishes a JWKS.
 *
 * ```ts
 * createRegistryApi({
 *   store,
 *   ...createOidcAuthorizer({
 *     issuer: 'https://example.okta.com/oauth2/default',
 *     audience: 'api://braid-console',
 *   }),
 * });
 * ```
 *
 * **The server is the enforcement point.** The console hides what a role cannot do, but that is a
 * courtesy; every request here carries a bearer token that is verified against the issuer's keys,
 * and a request without one is refused before any store is touched.
 *
 * Okta specifics that cause most first-run 401s: use a *custom* authorization server (its tokens
 * are verifiable by third parties; the org server's are not), and add a `groups` claim to the
 * **access** token. A client-credentials token (a CI service app) has no user and so no groups —
 * grant it a custom scope and put that scope in `scopeMap`, and in Okta's access policy allow only
 * the CI client to request it: a scope is whatever a permitted client asks for.
 */
export interface OidcAuthorizerOptions {
  /** The token issuer, exactly as it appears in `iss` — e.g. `https://example.okta.com/oauth2/default`. */
  issuer: string;
  /** Accepted `aud` value(s). Okta's default authorization server issues `api://default`. */
  audience: string | string[];
  /** Claim listing the caller's groups. Defaults to `groups`. */
  rolesClaim?: string;
  /**
   * Group name (from `rolesClaim`) → the actions it grants. A caller gets the union over every
   * group they hold. Defaults to {@link DEFAULT_ROLE_MAP}.
   */
  roleMap?: Record<string, readonly RegistryAction[]>;
  /**
   * Scope (from `scp` or `scope`) → the actions it grants, for client-credentials tokens that carry
   * no groups. Empty by default.
   *
   * Separate from `roleMap` on purpose. Group membership is administered; a scope is whatever a
   * client the authorization server permits chose to request — including the console's own SPA
   * client, which any signed-in viewer can drive. Map a scope only if the issuer's access policy
   * restricts it to the clients that should hold it.
   */
  scopeMap?: Record<string, readonly RegistryAction[]>;
  /**
   * Group name (from `rolesClaim`) → the tags its members own, or `'*'` for all of them — per-tag
   * ownership (see `owns` on the registry API). A caller owns the union over every group they hold.
   *
   * Omit it and there is no tag ownership: whoever may publish may change anything. With it, a
   * caller in no mapped group owns nothing, and so may change nothing, whatever `roleMap` grants.
   */
  tagMap?: Record<string, readonly string[] | '*'>;
  /**
   * Verification keys to use instead of fetching the issuer's — for tests and air-gapped networks.
   * When omitted, keys come from the issuer's `jwks_uri` (OIDC discovery) and are cached.
   */
  jwks?: JSONWebKeySet;
  /** Overrides discovery of the key set URL. */
  jwksUri?: string;
  /** Seconds of clock skew tolerated on `exp` and `nbf`. Defaults to 30. */
  clockTolerance?: number;
  fetch?: typeof fetch;
}

export const DEFAULT_ROLE_MAP: Readonly<Record<string, readonly RegistryAction[]>> = {
  'braid-viewers': ['read'],
  'braid-editors': ['read', 'publish', 'pin'],
};

/**
 * Asymmetric algorithms only. Accepting an HMAC algorithm against a public key set is the classic
 * key-confusion hole, and `none` is never a signature.
 */
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

type KeySet = ReturnType<typeof createLocalJWKSet> | ReturnType<typeof createRemoteJWKSet>;

type Verification = { ok: true; claims: JWTPayload } | { ok: false; response: Response };

export interface OidcAuthorizer {
  authorize(request: Request, action: RegistryAction): Promise<AuthorizeResult>;
  identify(request: Request): Promise<string | null>;
  /** Present only with a `tagMap`. */
  owns?: (request: Request) => Promise<OwnedTags>;
}

export function createOidcAuthorizer(options: OidcAuthorizerOptions): OidcAuthorizer {
  const { issuer, audience, rolesClaim = 'groups', roleMap = DEFAULT_ROLE_MAP, scopeMap = {}, clockTolerance = 30 } = options;
  const doFetch = options.fetch ?? globalThis.fetch;

  // Each request is verified once, however many actions are asked about (publish checks publish
  // and pin; /permissions checks all three; identify reads the same claims).
  const verified = new WeakMap<Request, Promise<Verification>>();

  const local = options.jwks ? createLocalJWKSet(options.jwks) : null;
  let remote: Promise<KeySet> | null = null;
  function keySet(): Promise<KeySet> {
    if (local) return Promise.resolve(local);
    const pending =
      remote ??
      resolveJwksUri().then(
        (uri): KeySet => createRemoteJWKSet(new URL(uri)),
        (error: unknown) => {
          remote = null; // an unreachable issuer should be retried, not remembered
          throw error;
        },
      );
    remote = pending;
    return pending;
  }

  async function resolveJwksUri(): Promise<string> {
    if (options.jwksUri) return options.jwksUri;
    const response = await doFetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    if (!response.ok) throw new Error(`OIDC discovery for ${issuer} failed with HTTP ${response.status}`);
    const { jwks_uri } = (await response.json()) as { jwks_uri?: string };
    if (!jwks_uri) throw new Error(`OIDC discovery for ${issuer} has no jwks_uri`);
    return jwks_uri;
  }

  function verify(request: Request): Promise<Verification> {
    let result = verified.get(request);
    if (!result) {
      result = verifyUncached(request);
      verified.set(request, result);
    }
    return result;
  }

  async function verifyUncached(request: Request): Promise<Verification> {
    const header = request.headers.get('authorization') ?? '';
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!match?.[1]) {
      return { ok: false, response: challenge('a bearer token is required', 'Bearer realm="braid-registry"') };
    }

    let set: KeySet;
    try {
      set = await keySet();
    } catch (error) {
      // The cause (an issuer URL, a network error) is for the operator's log, not the caller.
      console.warn('braid-registry: cannot load the token issuer keys', error);
      return { ok: false, response: jsonResponse({ error: 'token verification is unavailable' }, 503) };
    }

    try {
      // `exp` is required: jose accepts a token without one, which would never expire.
      const { payload } = await jwtVerify(match[1], set, { issuer, audience, algorithms: ALGORITHMS, clockTolerance, requiredClaims: ['exp'] });
      return { ok: true, claims: payload };
    } catch {
      // The reason stays server-side: telling a caller *why* their token failed helps an attacker
      // more than it helps a user, whose fix is the same either way — sign in again.
      return {
        ok: false,
        response: challenge('the bearer token is invalid or expired', 'Bearer realm="braid-registry", error="invalid_token"'),
      };
    }
  }

  const tagMap = options.tagMap;
  const owns = tagMap
    ? async (request: Request): Promise<OwnedTags> => {
        const result = await verify(request);
        if (!result.ok) return [];
        const tags = new Set<string>();
        for (const group of asList(result.claims[rolesClaim])) {
          // Own properties only, as in grants(): a group called "constructor" owns nothing.
          if (!Object.prototype.hasOwnProperty.call(tagMap, group)) continue;
          const owned = tagMap[group];
          if (owned === '*') return '*';
          for (const tag of owned ?? []) tags.add(tag);
        }
        return [...tags];
      }
    : undefined;

  return {
    ...(owns ? { owns } : {}),

    async authorize(request, action) {
      const result = await verify(request);
      if (!result.ok) return result.response;
      return grants(result.claims, rolesClaim, roleMap, scopeMap).has(action);
    },

    async identify(request) {
      const result = await verify(request);
      if (!result.ok) return null;
      const { claims } = result;
      for (const key of ['email', 'preferred_username', 'sub'] as const) {
        const value = claims[key];
        if (typeof value === 'string' && value) return value;
      }
      return null;
    },
  };
}

/** The actions a token's groups (under `roleMap`) and scopes (under `scopeMap`) grant. */
export function grants(
  claims: JWTPayload,
  rolesClaim: string,
  roleMap: Record<string, readonly RegistryAction[]>,
  scopeMap: Record<string, readonly RegistryAction[]> = {},
): Set<RegistryAction> {
  const actions = new Set<RegistryAction>();
  const add = (names: string[], map: Record<string, readonly RegistryAction[]>) => {
    for (const name of names) {
      // Own properties only: a group called "constructor" must not reach Object.prototype.
      if (!Object.prototype.hasOwnProperty.call(map, name)) continue;
      for (const action of map[name] ?? []) actions.add(action);
    }
  };
  add(asList(claims[rolesClaim]), roleMap);
  add([...asList(claims['scp']), ...asList(claims['scope'], ' ')], scopeMap);
  return actions;
}

function asList(value: unknown, separator?: string): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') return separator ? value.split(separator).filter(Boolean) : [value];
  return [];
}

function challenge(error: string, wwwAuthenticate: string): Response {
  return jsonResponse({ error }, 401, { 'www-authenticate': wwwAuthenticate });
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8', 'cache-control': 'no-store', ...headers },
  });
}
