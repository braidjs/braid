import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';

/**
 * The standalone app's Content-Security-Policy, as a meta tag in the built index.html.
 *
 * `script-src 'self'` is the point: only the hashed bundle runs, so markup that reached the page
 * some other way cannot execute. Styles stay inline-capable because the console injects one
 * scoped stylesheet and positions the layout preview with style attributes. `connect-src` allows
 * any origin because the API and the OIDC issuer are runtime configuration — one artifact
 * serves every environment — so tighten it, and add `frame-ancestors 'none'` (which a meta tag
 * cannot carry), with a response header where the console is served.
 *
 * Build only: the dev server needs a websocket for hot reload.
 */
export const CONSOLE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https: http:",
  // oidc-client-ts renews in a hidden iframe on the issuer when it holds no refresh token
  "frame-src 'self' https: http:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'braid-console-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CONSOLE_CSP }, injectTo: 'head-prepend' }],
    },
  };
}

/**
 * One project, two build outputs.
 *
 * `build` (this config, default) produces the **standalone app**: an index.html plus a hashed
 * bundle, deployable to object storage or any static host. The **library** build is `@nx/js:tsc`
 * in project.json — plain ESM with type declarations, React left external — because a mountable
 * component should ship as modules the consumer's own bundler can treeshake, not as a
 * pre-bundled blob with a second React inside it.
 */
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/braid-console',
  esbuild: { jsx: 'automatic' },
  plugins: [contentSecurityPolicy()],
  // Relative asset URLs, so one bundle works at any mount path — served from a CDN root, or from
  // `/__braid/console` on the gateway itself. An absolute base would pin the artifact to a
  // deployment, which is exactly what the snapshot model refuses to do for configuration.
  base: './',
  build: {
    outDir: '../../dist/apps/braid-console',
    emptyOutDir: true,
    target: 'es2022',
    reportCompressedSize: true,
  },
  resolve: {
    alias: [
      {
        find: '@braidlabs/gateway',
        replacement: resolve(import.meta.dirname, '../braid-gateway/src/index.ts'),
      },
      {
        find: '@braidlabs/registry',
        replacement: resolve(import.meta.dirname, '../braid-registry/src/index.ts'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,ts,tsx}'],
    reporters: ['default'],
  },
});
