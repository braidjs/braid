import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/sdui',
  resolve: {
    alias: {
      '@braidlabs/skew': resolve(import.meta.dirname, '../skew/src/index.ts'),
      '@braidlabs/contract': resolve(
        import.meta.dirname,
        '../contract/src/index.ts',
      ),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,ts}'],
    reporters: ['default'],
  },
});
