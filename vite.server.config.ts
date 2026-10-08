import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

// Server bundle: the same shared simulation, compiled for Node.
export default defineConfig({
  root,
  resolve: {
    alias: {
      '@shared': resolve(root, 'shared'),
      '@client': resolve(root, 'client/src')
    }
  },
  build: {
    ssr: resolve(root, 'server/index.ts'),
    outDir: resolve(root, 'dist-server'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false
  }
});
