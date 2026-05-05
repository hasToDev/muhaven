import { defineConfig } from 'vite';

export default defineConfig({
  base: '/telegram-mini-app/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 7779,
    strictPort: true,
  },
});
