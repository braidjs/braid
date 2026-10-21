/**
 * Sign-in for the standalone console: OIDC Authorization Code with PKCE — Okta, or any issuer.
 *
 * This lives in `app/`, not `lib/`, for the same reason the URL does: the *library* never performs
 * a login. Mounted inside a portal it inherits that portal's session through `headers()`; only the
 * deployable app owns a session, and only when its config names an issuer.
 *
 * `oidc-client-ts` is imported dynamically, so a console deployed without `auth` downloads none of
 * it. Tokens are kept in `sessionStorage` (the library's default): per tab, gone when it closes.
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
  /** Defaults to `openid profile email`. Okta needs `groups` only if the claim is scope-gated. */
  scopes?: string;
  /** Sent as `audience` for issuers that select the API by it (Auth0); Okta sets it per server. */
  audience?: string;
}

export interface Session {
  headers: () => Promise<Record<string, string>>;
  /** Email, else preferred_username, else subject. */
  user: string;
  signOut: () => Promise<void>;
}

/**
 * Resolves to a signed-in session, or never resolves because the page is navigating to the
 * issuer. Call once, before rendering anything that makes requests.
 */
export async function signIn(config: AuthConfig): Promise<Session> {
  const { UserManager, WebStorageStateStore } = await import('oidc-client-ts');

  // The callback lands on the console's own URL without its hash, so the view a user was on is
  // carried through the round trip in the request state and restored afterwards.
  const here = `${location.origin}${location.pathname}`;
  const manager = new UserManager({
    authority: config.issuer,
    client_id: config.clientId,
    redirect_uri: here,
    post_logout_redirect_uri: here,
    response_type: 'code',
    scope: config.scopes ?? 'openid profile email',
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
    // The issuer refused (a user not assigned to the app, say). Retrying would loop; say why.
    throw new Error(`sign-in failed: ${params.get('error_description') ?? params.get('error')}`);
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
      const current = await manager.getUser();
      return current && !current.expired ? { authorization: `Bearer ${current.access_token}` } : {};
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
