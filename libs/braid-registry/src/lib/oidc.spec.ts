import { describe, expect, it, beforeAll } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet, type JWTPayload } from 'jose';
import type { FragmentManifest } from '@braidlabs/gateway';
import { createRegistryApi } from './api.js';
import { memorySnapshotStore } from './store.js';
import { createOidcAuthorizer, type OidcAuthorizerOptions } from './oidc.js';

const ISSUER = 'https://example.okta.com/oauth2/default';
const AUDIENCE = 'api://braid-console';
const BASE = 'https://ops.example/__braid/registry-api';
const manifests: FragmentManifest[] = [{ id: 'billing', endpoint: 'https://billing.internal' }];

let jwks: JSONWebKeySet;
let privateKey: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
});

async function token(claims: JWTPayload = {}, options: { key?: CryptoKey; expiresIn?: string | number; issuer?: string; audience?: string } = {}) {
  return new SignJWT({ email: 'dana@example.com', groups: ['braid-editors'], ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setSubject('00u1abc')
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(options.key ?? privateKey);
}

function authorizer(overrides: Partial<OidcAuthorizerOptions> = {}) {
  return createOidcAuthorizer({ issuer: ISSUER, audience: AUDIENCE, jwks, ...overrides });
}

const request = (bearer?: string, init: RequestInit = {}) =>
  new Request(`${BASE}/head`, { ...init, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

describe('createOidcAuthorizer', () => {
  it('grants an editor group read, publish and pin', async () => {
    const auth = authorizer();
    const req = request(await token());

    expect(await auth.authorize(req, 'read')).toBe(true);
    expect(await auth.authorize(req, 'publish')).toBe(true);
    expect(await auth.authorize(req, 'pin')).toBe(true);
  });

  it('grants a viewer group read only', async () => {
    const auth = authorizer();
    const req = request(await token({ groups: ['braid-viewers'] }));

    expect(await auth.authorize(req, 'read')).toBe(true);
    expect(await auth.authorize(req, 'publish')).toBe(false);
  });

  it('maps scopes as well as groups, for client-credentials tokens that have no user', async () => {
    const auth = authorizer({ roleMap: { 'braid:publish': ['read', 'publish', 'pin'] } });
    const ci = await token({ groups: undefined, email: undefined, scp: ['braid:publish'] });

    expect(await auth.authorize(request(ci), 'publish')).toBe(true);
    expect(await auth.identify(request(ci))).toBe('00u1abc');
  });

  it('reads a space-delimited scope claim too', async () => {
    const auth = authorizer({ roleMap: { 'braid:publish': ['publish'] } });

    expect(await auth.authorize(request(await token({ groups: undefined, scope: 'openid braid:publish' })), 'publish')).toBe(true);
  });

  it('denies a group the role map does not name, with 403 rather than 401', async () => {
    const auth = authorizer();
    const req = request(await token({ groups: ['everyone'] }));

    expect(await auth.authorize(req, 'read')).toBe(false);
  });

  it('does not let a group name reach Object.prototype', async () => {
    const auth = authorizer();

    expect(await auth.authorize(request(await token({ groups: ['constructor', '__proto__'] })), 'read')).toBe(false);
  });

  it('challenges a request with no token', async () => {
    const outcome = await authorizer().authorize(request(), 'read');

    expect(outcome).toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(401);
    expect((outcome as Response).headers.get('www-authenticate')).toMatch(/^Bearer/);
  });

  describe('refuses tokens that must not verify', () => {
    const cases: [string, () => Promise<string>][] = [
      ['expired', () => token({}, { expiresIn: Math.floor(Date.now() / 1000) - 3600 })],
      ['from another issuer', () => token({}, { issuer: 'https://evil.example/oauth2/default' })],
      ['for another audience', () => token({}, { audience: 'api://something-else' })],
      ['signed by another key', () => token({}, { key: otherKey })],
      [
        'with alg none',
        async () => {
          const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
          const now = Math.floor(Date.now() / 1000);
          const body = base64url(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, exp: now + 300, groups: ['braid-editors'] }));
          return `${header}.${body}.`;
        },
      ],
      [
        'with a tampered payload',
        async () => {
          const [header, , signature] = (await token({ groups: ['braid-viewers'] })).split('.');
          const now = Math.floor(Date.now() / 1000);
          const body = base64url(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, exp: now + 300, groups: ['braid-editors'] }));
          return `${header}.${body}.${signature}`;
        },
      ],
      [
        'with HS256 keyed by the public key (key confusion)',
        async () =>
          new SignJWT({ groups: ['braid-editors'] })
            .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setExpirationTime('5m')
            .sign(new TextEncoder().encode(JSON.stringify(jwks.keys[0]))),
      ],
    ];

    it.each(cases)('%s', async (_name, make) => {
      const outcome = await authorizer().authorize(request(await make()), 'read');

      expect(outcome).toBeInstanceOf(Response);
      expect((outcome as Response).status).toBe(401);
      expect((outcome as Response).headers.get('www-authenticate')).toMatch(/invalid_token/);
    });
  });

  it('identifies the caller by email, then preferred_username, then sub', async () => {
    const auth = authorizer();

    expect(await auth.identify(request(await token()))).toBe('dana@example.com');
    expect(await auth.identify(request(await token({ email: undefined, preferred_username: 'dana' })))).toBe('dana');
    expect(await auth.identify(request(await token({ email: undefined })))).toBe('00u1abc');
    expect(await auth.identify(request())).toBeNull();
  });

  it('answers 503 when the issuer cannot be reached, and retries next time', async () => {
    let calls = 0;
    const auth = authorizer({
      jwks: undefined,
      fetch: (async () => {
        calls += 1;
        return new Response('down', { status: 502 });
      }) as typeof fetch,
    });

    const first = (await auth.authorize(request(await token()), 'read')) as Response;
    await auth.authorize(request(await token()), 'read');

    expect(first.status).toBe(503);
    expect(calls).toBe(2);
  });

  describe('through the registry API', () => {
    const post = (bearer: string, body: unknown) =>
      new Request(`${BASE}/snapshots`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${bearer}` },
      });

    it('lets an editor publish, recording the verified email', async () => {
      const store = memorySnapshotStore();
      const api = createRegistryApi({ store, ...authorizer() });

      const response = await api.handle(post(await token(), { manifests, labels: { publishedBy: 'forged' } }));
      const result = await response!.json();

      expect(response?.status).toBe(201);
      expect((await store.get(result.snapshot.id))?.labels?.['publishedBy']).toBe('dana@example.com');
    });

    it('refuses a viewer’s publish with 403 and an anonymous read with 401', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore(), ...authorizer() });

      expect((await api.handle(post(await token({ groups: ['braid-viewers'] }), { manifests })))?.status).toBe(403);
      expect((await api.handle(request()))?.status).toBe(401);
    });

    it('reports permissions for the caller', async () => {
      const api = createRegistryApi({ store: memorySnapshotStore(), ...authorizer() });
      const viewer = await token({ groups: ['braid-viewers'] });

      const body = await (await api.handle(new Request(`${BASE}/permissions`, { headers: { authorization: `Bearer ${viewer}` } })))!.json();

      expect(body).toEqual({ read: true, publish: false, pin: false, actor: 'dana@example.com' });
    });
  });
});
