/**
 * Vitest config for the frontend SPA.
 *
 * Inherits the Vite config's resolve.alias (so `@/...` imports resolve
 * the same way as the dev server + build) but strips the production
 * plugins that don't belong in a unit-test context — `tailwindcss`,
 * `wasm`, and `nodePolyfills`. Keeping them in would pull the WASM
 * bundle + ~50MB of polyfill globals into every test run for no benefit;
 * unit tests target pure TS/Vue composables, not the WebAssembly cofhe
 * worker (which has its own integration smoke at deploy-time).
 *
 * happy-dom is the test environment — lighter than jsdom for the small
 * DOM surface our composables touch (mostly `window.location` reads +
 * `console.*` spying). If a future test needs the heavier jsdom (e.g.
 * Web Crypto APIs), switch per-file via `// @vitest-environment jsdom`.
 *
 * Vue's `defineComponent` + `<script setup>` are first-class via
 * `@vitejs/plugin-vue`; test files import `.vue` SFCs the same way the
 * runtime does.
 */
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    // Vitest's default include picks up `**/*.{test,spec}.{ts,tsx}` —
    // explicit so a future contributor doesn't have to guess where to
    // put a test. Matches backend's convention: `src/**/__tests__/`.
    include: ['src/**/__tests__/**/*.test.ts'],
    // Keep the default reporter; CI swaps via `--reporter=dot` to keep
    // output compact (mirrors the backend `pnpm test --reporter=dot`).
  },
})
