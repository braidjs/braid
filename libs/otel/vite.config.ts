import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/otel',
  resolve: {
    alias: [{ find: '@braidlabs/gateway', replacement: resolve(import.meta.dirname, '../braid-gateway/src/index.ts') }],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,ts}'],
    reporters: ['default'],
  },
});
