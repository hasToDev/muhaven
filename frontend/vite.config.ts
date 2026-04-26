import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import wasm from 'vite-plugin-wasm'
import { resolve } from 'path'

export default defineConfig(() => ({
  plugins: [
    vue(),
    tailwindcss(),
    wasm(),
    nodePolyfills({
      include: ['buffer', 'process'],
      globals: { Buffer: true, process: true },
    }),
  ],
  // All GH Pages deploys go through the muhaven-web repo with a custom-domain
  // CNAME (muhaven.hasto.dev), so base is always `/`.
  base: '/',
  server: {
    port: 7778,
    // Cross-origin isolation headers required by the cofhe SDK's TFHE
    // worker — without them, `SharedArrayBuffer` (used by tfhe.wasm for
    // parallel encrypt) is unavailable and the worker dies silently
    // with a `Worker error event` whose `.message` is undefined. Symptom
    // hit during Phase 8 Cash-mode wrap from a fresh kernel; the production
    // GH Pages build is served behind Cloudflare with these headers set,
    // the Vite dev server needed them too. Trade-off: third-party iframes
    // / images without `crossorigin` get blocked from loading — we don't
    // embed any such resources today.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
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
