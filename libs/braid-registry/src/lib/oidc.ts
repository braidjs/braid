import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import type { AuthorizeResult, RegistryAction } from './api.js';

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
 * grant it a custom scope and map the scope, since role map keys match groups and scopes alike.
 */
export interface OidcAuthorizerOptions {
  /** The token issuer, exactly as it appears in `iss` — e.g. `https://example.okta.com/oauth2/default`. */
  issuer: string;
  /** Accepted `aud` value(s). Okta's default authorization server issues `api://default`. */
  audience: string | string[];
  /** Claim listing the caller's groups. Defaults to `groups`. */
  rolesClaim?: string;
  /**
   * Group or scope name → the actions it grants. A caller gets the union over everything they hold.
   * Defaults to {@link DEFAULT_ROLE_MAP}.
   */
  roleMap?: Record<string, readonly RegistryAction[]>;
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
}

export function createOidcAuthorizer(options: OidcAuthorizerOptions): OidcAuthorizer {
  const { issuer, audience, rolesClaim = 'groups', roleMap = DEFAULT_ROLE_MAP, clockTolerance = 30 } = options;
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
      return {
        ok: false,
        response: jsonResponse({ error: `cannot verify tokens: ${error instanceof Error ? error.message : String(error)}` }, 503),
      };
    }

    try {
      const { payload } = await jwtVerify(match[1], set, { issuer, audience, algorithms: ALGORITHMS, clockTolerance });
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

  return {
    async authorize(request, action) {
      const result = await verify(request);
      if (!result.ok) return result.response;
      return grants(result.claims, rolesClaim, roleMap).has(action);
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

/** The actions a token's groups and scopes grant, under a role map. */
export function grants(
  claims: JWTPayload,
  rolesClaim: string,
  roleMap: Record<string, readonly RegistryAction[]>,
): Set<RegistryAction> {
  const held = [...asList(claims[rolesClaim]), ...asList(claims['scp']), ...asList(claims['scope'], ' ')];
  const actions = new Set<RegistryAction>();
  for (const name of held) {
    // Own properties only: a group called "constructor" must not reach Object.prototype.
    if (!Object.prototype.hasOwnProperty.call(roleMap, name)) continue;
    for (const action of roleMap[name] ?? []) actions.add(action);
  }
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
