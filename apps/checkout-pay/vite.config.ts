import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

/**
 * Hosted-checkout buyer page (Wave 4 P5 → Wave-5 port).
 *
 * 2026-05-15 subdomain-collapse migration: served from `muhaven.app/pay/`
 * (same origin as the dashboard) instead of the prior `pay.muhaven.app`
 * subdomain. `base: '/pay/'` so Vite emits asset URLs as `/pay/assets/*`.
 * The URL shape becomes `<origin>/pay/c/<sessionId>#k=<key>`; GitHub
 * Pages serves `muhaven-web/pay/404.html` (nearest-up the tree) as the
 * SPA fallback so any `/pay/c/*` path resolves to the buyer page index.
 *
 * Why moved off the subdomain: Plan C v1+v2 confirmed empirically that
 * Chrome on Windows 11 defers the WebAuthn picker to the OS-native
 * Windows Hello dialog for platform-bound credentials, which is blind
 * to Chrome's GPM credential store. Apex-RPID + subdomain origin was
 * spec-correct but didn't unlock GPM signing. Same-origin = the
 * dashboard's GPM-backed credential becomes the buyer-page credential
 * by construction, and Chrome stays in its in-browser picker.
 *
 * Legacy origin `pay.muhaven.app` is repurposed as a 2-line
 * `window.location.replace` redirect shim (see muhaven-checkout-web
 * post-migration) so in-flight URLs minted pre-cutover still work.
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
  base: '/pay/',
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
