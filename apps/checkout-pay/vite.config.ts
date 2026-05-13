import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

/**
 * Hosted-checkout buyer page (Wave 4 P5 → Wave-5 port).
 *
 * `base` is `/` so the URL pattern `/c/<sessionId>#k=<key>` is rendered
 * by the SPA's index.html for every path. In production the Cloudflare
 * tunnel rewrites every `/c/*` to `/index.html` so the page parses the
 * sessionId out of `location.pathname` itself.
 *
 * Static-served deployment target: `pay.muhaven.app` (prod) /
 * `pay-stage.muhaven.app` (stage). ALL deployments share the dashboard's
 * apex RP ID (`muhaven.app`) so passkey kernels created here are
 * recoverable from the dashboard.
 *
 * Wave-5 buyer-side port (P1): added `vite-plugin-node-polyfills` for
 * `@zerodev/sdk`'s `events` / `buffer` / `process` imports (Node stdlib
 * that doesn't exist in the browser). Same shim shape the dashboard's
 * `frontend/vite.config.ts` uses, narrowed to the minimum set the
 * ZeroDev passkey ceremony actually pulls in.
 */
export default defineConfig({
  plugins: [
    nodePolyfills({
      include: ['buffer', 'process', 'events'],
      globals: { Buffer: true, process: true },
    }),
  ],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Wave 5 P3: `esnext` (was es2022) so Vite's code-splitting for the
    // cofhe SDK's worker entry compiles cleanly. The cofhe `@cofhe/sdk/web`
    // package ships dynamic-import chunks that fail to bundle under
    // older targets if any output format defaults to iife.
    target: 'esnext',
    sourcemap: true,
  },
  // Wave 5 P3 — cofhe SDK ships web workers + WASM. Match the dashboard's
  // `frontend/vite.config.ts` worker + optimizeDeps shape:
  //  - `worker.format: 'es'` → Vite emits the worker entry as an ES
  //    module (default is iife, which breaks code-splitting per the
  //    rollup error `UMD and IIFE output formats are not supported for
  //    code-splitting builds`).
  //  - `optimizeDeps.exclude` → cofhe SDK + tfhe ship sibling worker
  //    files that Vite's pre-bundler doesn't relocate into
  //    node_modules/.vite/deps, so the runtime worker URL would 404.
  //    Excluding them keeps the worker manager loading from the
  //    unbundled source location.
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['tfhe', '@cofhe/sdk'],
  },
  server: {
    port: 7780,
    strictPort: true,
  },
});
