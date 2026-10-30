import { defineConfig } from 'vitest/config';

/**
 * Browser end-to-end checks: real Chromium against a real gateway, for the behaviour jsdom cannot
 * show — storage events between realms, cross-frame messages, cookies, CSS that decides what is
 * visible. Kept out of `nx run-many -t test` on purpose: it needs a browser, so it runs as its own
 * CI job (`npm run e2e`).
 */
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../node_modules/.vite/e2e',
  test: {
    environment: 'node',
    include: ['**/*.e2e.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // one browser per file, and files share nothing, but one at a time keeps a slow CI runner honest
    fileParallelism: false,
    reporters: ['default'],
  },
});
