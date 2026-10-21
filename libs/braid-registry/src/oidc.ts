/**
 * @braidlabs/registry/oidc — `authorize` and `identify` for the registry API from OIDC access
 * tokens (Okta, or any issuer with a JWKS).
 *
 * A separate entry point because it depends on `jose`, an optional peer: a registry used without
 * OIDC installs nothing extra, and the main entry stays dependency-free and browser-safe.
 */

export { createOidcAuthorizer, grants, DEFAULT_ROLE_MAP } from './lib/oidc.js';
export type { OidcAuthorizer, OidcAuthorizerOptions } from './lib/oidc.js';
