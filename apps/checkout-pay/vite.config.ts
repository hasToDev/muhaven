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
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 7780,
    strictPort: true,
  },
});
