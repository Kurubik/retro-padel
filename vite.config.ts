import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(root, 'client'),
  publicDir: resolve(root, 'client/public'),
  resolve: {
    alias: {
      '@shared': resolve(root, 'shared'),
      '@client': resolve(root, 'client/src')
    }
  },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0
  },
  server: { port: 5173, host: '127.0.0.1' },
  test: {
    root,
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false
  }
});
