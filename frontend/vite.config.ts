import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import wasm from 'vite-plugin-wasm'
import { resolve } from 'path'

export default defineConfig(({ mode }) => ({
  plugins: [
    vue(),
    tailwindcss(),
    wasm(),
    nodePolyfills({
      include: ['buffer', 'process'],
      globals: { Buffer: true, process: true },
    }),
  ],
  base: mode === 'ghpages' ? '/muhaven/' : '/',
  server: {
    port: 7778,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
    // @muhaven/sdk is symlinked from packages/sdk. Without this dedup,
    // vite follows the symlink into the root pnpm dep tree for viem's
    // transitive deps (isows) and fails to resolve the frontend's
    // vite-plugin-node-polyfills shims.
    dedupe: ['viem', 'isows', '@cofhe/sdk'],
  },
  optimizeDeps: {
    // Exclude tfhe from pre-bundling — it has WASM that needs special handling
    exclude: ['tfhe'],
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'esnext',
  },
}))
