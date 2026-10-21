import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

/**
 * Sign-in for the standalone console: OIDC Authorization Code with PKCE — Okta, or any issuer.
 *
 * This lives in `app/`, not `lib/`, for the same reason the URL does: the *library* never performs
 * a login. Mounted inside a portal it inherits that portal's session through `headers()`; only the
 * deployable app owns a session, and only when its config names an issuer.
 *
 * This module is itself loaded only when `auth` is configured, so a console deployed without it
 * downloads none of `oidc-client-ts`. Tokens are kept in `sessionStorage` (the library's default): per tab, gone when it closes.
 * Anything script-readable is exposed to XSS on this origin, which is why the console never
 * renders a shell's own scripts or styles and why the deployment docs ask for a strict CSP.
 *
 * The identity shown here is the ID token's. What the server *decides* with is the access token,
 * verified on every request; see `createOidcAuthorizer` in `@braidlabs/registry/oidc`.
 */
export interface AuthConfig {
  /** e.g. `https://example.okta.com/oauth2/default` — a custom authorization server for Okta. */
  issuer: string;
  /** The console's SPA application id. */
  clientId: string;
  /**
   * Defaults to `openid profile email offline_access`. `offline_access` asks for a refresh token,
   * which is how the session renews without a hidden iframe; enable the Refresh Token grant on the
   * Okta app. Okta needs `groups` here only if the claim is scope-gated.
   */
  scopes?: string;
  /** Sent as `audience` for issuers that select the API by it (Auth0); Okta sets it per server. */
  audience?: string;
}

export interface Session {
  headers: () => Promise<Record<string, string>>;
  /** Email, else preferred_username, else subject. */
  user: string;
  signOut: () => Promise<void>;
  /**
   * For a token the server would not accept although it has not expired (the issuer rotated its
   * keys; the API expects another audience). Signs in again, at most once a minute, so a
   * misconfiguration produces a message rather than a redirect loop. Returns false when it held back.
   */
  signInAgain: () => boolean;
}

const RETRY_KEY = 'braid-console:sign-in-again';
const RETRY_WINDOW_MS = 60_000;

/**
 * Resolves to a signed-in session, or never resolves because the page is navigating to the
 * issuer. Call once, before rendering anything that makes requests.
 */
export async function signIn(config: AuthConfig): Promise<Session> {
  // The callback lands on the console's own URL without its hash, so the view a user was on is
  // carried through the round trip in the request state and restored afterwards.
  const here = `${location.origin}${location.pathname}`;
  const manager = new UserManager({
    authority: config.issuer,
    client_id: config.clientId,
    redirect_uri: here,
    post_logout_redirect_uri: here,
    response_type: 'code',
    scope: config.scopes ?? 'openid profile email offline_access',
    automaticSilentRenew: true,
    userStore: new WebStorageStateStore({ store: sessionStorage }),
    ...(config.audience ? { extraQueryParams: { audience: config.audience } } : {}),
  });

  const params = new URLSearchParams(location.search);
  let user = null;

  if (params.has('code') && params.has('state')) {
    user = await manager.signinRedirectCallback();
    const hash = typeof user.state === 'object' && user.state && 'hash' in user.state ? String(user.state.hash) : '';
    // Strip `code` and `state` so a reload or a copied link does not replay a spent grant.
    history.replaceState(null, '', `${location.pathname}${hash}`);
  } else if (params.has('error')) {
    // The issuer refused (a user not assigned to the app, say). Retrying would loop, so stop and
    // say so — by error code only: the description is free text anyone can put in a link.
    const code = (params.get('error') ?? '').replace(/[^a-z_]/gi, '').slice(0, 40);
    throw new Error(`the identity provider refused sign-in (${code || 'unknown error'})`);
  } else {
    user = await manager.getUser();
  }

  if (!user || user.expired) {
    await manager.signinRedirect({ state: { hash: location.hash } });
    return new Promise<never>(() => undefined);
  }

  const profile = user.profile;
  return {
    user: String(profile.email ?? profile.preferred_username ?? profile.sub),
    headers: async (): Promise<Record<string, string>> => {
      let current = await manager.getUser();
      if (!current || current.expired) {
        // Background renewal missed (a sleeping laptop, an issuer that issued no refresh token).
        // Try once more quietly; failing that, sign in again and come back to this view.
        current = await manager.signinSilent().catch(() => null);
        if (!current) {
          await manager.signinRedirect({ state: { hash: location.hash } });
          return new Promise<never>(() => undefined);
        }
      }
      return { authorization: `Bearer ${current.access_token}` };
    },
    signInAgain: () => {
      const last = Number(sessionStorage.getItem(RETRY_KEY) ?? 0);
      if (Date.now() - last < RETRY_WINDOW_MS) return false;
      sessionStorage.setItem(RETRY_KEY, String(Date.now()));
      void manager.removeUser().then(() => manager.signinRedirect({ state: { hash: location.hash } }));
      return true;
    },
    signOut: async () => {
      try {
        await manager.signoutRedirect();
      } catch {
        // No end_session_endpoint: forget the tokens locally and start over.
        await manager.removeUser();
        location.reload();
      }
    },
  };
}
