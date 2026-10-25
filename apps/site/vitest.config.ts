import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/site',
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'api/**/*.spec.ts', 'aws/**/*.spec.ts'],
    reporters: ['default'],
    // The spec runs the real build once, which bundles the host runtime and six fragments.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
