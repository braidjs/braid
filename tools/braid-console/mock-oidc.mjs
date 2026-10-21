/**
 * A stand-in for Okta, for the console demo only.
 *
 * It speaks enough OIDC for the real code paths to run unmodified: discovery, an authorize page
 * that lets you pick a role instead of a password, a token endpoint with PKCE, a JWKS, and
 * logout. Tokens are RS256-signed with a key generated at startup, and the registry API verifies
 * them with the same `createOidcAuthorizer` a production deployment uses — so what is mocked is
 * the identity provider, never the verification.
 *
 * Not a security boundary. Anyone who can reach the demo port can be anyone.
 */
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export const MOCK_CLIENT_ID = 'braid-console-demo';
export const MOCK_AUDIENCE = 'api://braid-console';

/** Demo users. `candidate` may publish but not pin, which is what shows the candidate flow. */
const USERS = {
  viewer: { email: 'viewer@example.com', name: 'Vic Viewer', groups: ['braid-viewers'] },
  candidate: { email: 'casey@example.com', name: 'Casey Contributor', groups: ['braid-contributors'] },
  editor: { email: 'dana@example.com', name: 'Dana Editor', groups: ['braid-editors'] },
};

export const MOCK_ROLE_MAP = {
  'braid-viewers': ['read'],
  'braid-contributors': ['read', 'publish'],
  'braid-editors': ['read', 'publish', 'pin'],
};

export async function createMockOidc({ origin, prefix = '/mock-oidc' }) {
  const issuer = `${origin}${prefix}`;
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'demo-1', alg: 'RS256', use: 'sig' }] };

  const codes = new Map();
  const refreshTokens = new Map();

  const sign = (claims, audience, ttl = '15m') =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'demo-1' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(ttl)
      .sign(privateKey);

  async function tokens(role, { nonce, clientId }) {
    const user = USERS[role];
    const sub = `demo-${role}`;
    const access_token = await sign({ sub, email: user.email, groups: user.groups, scp: ['openid', 'profile', 'email'], cid: clientId }, MOCK_AUDIENCE);
    const id_token = await sign({ sub, email: user.email, name: user.name, ...(nonce ? { nonce } : {}) }, clientId);
    const refresh_token = randomBytes(24).toString('base64url');
    refreshTokens.set(refresh_token, { role, clientId });
    return { access_token, id_token, refresh_token, token_type: 'Bearer', expires_in: 900, scope: 'openid profile email' };
  }

  /** Only the demo's own origin may receive codes or be redirected to after logout. */
  const allowed = (uri) => typeof uri === 'string' && (uri === origin || uri.startsWith(`${origin}/`));

  async function handle(request, response) {
    const url = new URL(request.url, origin);
    if (!url.pathname.startsWith(prefix)) return false;
    const route = url.pathname.slice(prefix.length);

    if (route === '/.well-known/openid-configuration') {
      return json(response, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/keys`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'profile', 'email'],
      });
    }

    if (route === '/keys') return json(response, jwks);

    if (route === '/authorize') {
      const params = Object.fromEntries(url.searchParams);
      if (params.client_id !== MOCK_CLIENT_ID || !allowed(params.redirect_uri)) {
        return text(response, 400, 'unknown client or redirect_uri');
      }
      if (params.response_type !== 'code' || params.code_challenge_method !== 'S256' || !params.code_challenge) {
        return text(response, 400, 'this issuer requires the authorization code flow with PKCE (S256)');
      }

      const role = url.searchParams.get('role');
      if (role && USERS[role]) {
        const code = randomBytes(24).toString('base64url');
        codes.set(code, { role, clientId: params.client_id, redirectUri: params.redirect_uri, challenge: params.code_challenge, nonce: params.nonce, expires: Date.now() + 60_000 });
        const back = new URL(params.redirect_uri);
        back.searchParams.set('code', code);
        if (params.state) back.searchParams.set('state', params.state);
        response.writeHead(302, { location: back.toString(), 'cache-control': 'no-store' }).end();
        return true;
      }

      // No password: the point of the demo is roles, so the "login" is choosing one.
      const hidden = Object.entries(params)
        .map(([key, value]) => `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`)
        .join('');
      const buttons = Object.entries(USERS)
        .map(([key, user]) => `<button name="role" value="${key}"><b>${escape(user.name)}</b><span>${escape(user.email)} · ${escape(user.groups.join(', '))}</span></button>`)
        .join('');
      response.writeHead(200, { 'content-type': 'text/html;charset=UTF-8', 'cache-control': 'no-store' });
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mock Okta — sign in</title>
<style>body{font:15px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f3f2f1;color:#201f1e}
main{background:#fff;padding:32px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.12);width:min(420px,90vw)}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 20px;color:#605e5c}form{display:flex;flex-direction:column;gap:8px}
button{font:inherit;text-align:left;display:flex;flex-direction:column;gap:2px;padding:12px 14px;border:1px solid #c8c6c4;border-radius:6px;background:#fff;cursor:pointer}
button:hover,button:focus-visible{border-color:#0f6cbd;outline:none}button span{font-size:13px;color:#605e5c}</style></head>
<body><main><h1>Mock Okta</h1><p>Demo identity provider. Choose who to sign in as.</p>
<form method="get" action="${escape(issuer)}/authorize">${hidden}${buttons}</form></main></body></html>`);
      return true;
    }

    if (route === '/token' && request.method === 'POST') {
      const form = new URLSearchParams(await body(request));
      if (form.get('grant_type') === 'authorization_code') {
        const grant = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (!grant || grant.expires < Date.now() || grant.redirectUri !== form.get('redirect_uri') || grant.clientId !== form.get('client_id') || grant.challenge !== challenge) {
          return json(response, { error: 'invalid_grant' }, 400);
        }
        return json(response, await tokens(grant.role, grant));
      }
      if (form.get('grant_type') === 'refresh_token') {
        const grant = refreshTokens.get(form.get('refresh_token') ?? '');
        refreshTokens.delete(form.get('refresh_token') ?? '');
        if (!grant) return json(response, { error: 'invalid_grant' }, 400);
        return json(response, await tokens(grant.role, grant));
      }
      return json(response, { error: 'unsupported_grant_type' }, 400);
    }

    if (route === '/logout') {
      const target = url.searchParams.get('post_logout_redirect_uri');
      response.writeHead(302, { location: allowed(target) ? target : origin, 'cache-control': 'no-store' }).end();
      return true;
    }

    // For curl: an access token for a role, without the browser dance.
    if (route === '/dev-token') {
      const role = url.searchParams.get('role') ?? 'viewer';
      if (!USERS[role]) return text(response, 400, `role must be one of ${Object.keys(USERS).join(', ')}`);
      return text(response, 200, (await tokens(role, { clientId: MOCK_CLIENT_ID })).access_token);
    }

    return text(response, 404, 'not found');
  }

  return { issuer, jwks, handle };
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  response.end(JSON.stringify(value));
  return true;
}

function text(response, status, value) {
  response.writeHead(status, { 'content-type': 'text/plain;charset=UTF-8', 'cache-control': 'no-store' });
  response.end(value);
  return true;
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function escape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
