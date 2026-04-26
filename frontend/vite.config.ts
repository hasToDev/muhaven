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
    // Exclude packages that ship web workers + WASM — Vite's pre-bundler
    // copies them into node_modules/.vite/deps/ but doesn't relocate the
    // sibling worker files (e.g. zkProve.worker.js), so the runtime
    // request for the worker 404s and the cofhe SDK's Worker Manager
    // surfaces a generic "Worker error event" with no message.
    //
    // `tfhe` ships the WASM blob; `@cofhe/sdk` ships the worker manager
    // that loads `zkProve.worker.js`. Both must serve from their
    // unbundled source location for worker URLs to resolve.
    exclude: ['tfhe', '@cofhe/sdk'],

    // Force pre-bundle the CJS leaves of `@cofhe/sdk` so they get a
    // proper ESM-interop wrapper. Without this, the un-bundled SDK
    // chunks `import * as nacl from 'tweetnacl'` against raw CJS that
    // has no `default` export, surfacing as
    //   "does not provide an export named 'default'"
    // on first encrypt op. Add new entries here whenever a CJS dep
    // bubbles up from a fresh @cofhe/sdk release.
    include: ['tweetnacl', 'iframe-shared-storage'],
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'esnext',
  },
}))
