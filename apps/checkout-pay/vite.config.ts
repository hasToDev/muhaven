import { defineConfig } from 'vite';

/**
 * Hosted-checkout buyer page (Wave 4 P5).
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
 */
export default defineConfig({
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
