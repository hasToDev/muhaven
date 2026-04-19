import { defineConfig } from '@playwright/test'

/**
 * MuHaven Playwright config.
 *
 * Serial execution — passkey profile cannot be shared concurrently and
 * on-chain nonce ordering must be preserved.
 *
 * Per-project structure mirrors the Suite layout in
 * development/DEV_WAVE_3/qa/PLAYWRIGHT_QA.md §6.
 *
 * Biometric-gated tests use `test.setTimeout(0)` individually rather than
 * a global override, so public-route regressions fail fast (30s) while
 * auth / distribute tests can wait as long as the human needs.
 */
export default defineConfig({
  // Each project scopes its own testDir — no top-level default needed.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'https://muhaven.hasto.dev',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1400, height: 900 },
    headless: false,
  },
  timeout: 30_000,
  expect: { timeout: 10_000 },
  projects: [
    { name: 'public', testDir: './tests/public' },
    { name: 'auth', testDir: './tests/auth' },
    { name: 'investor', testDir: './tests/investor' },
    { name: 'issuer', testDir: './tests/issuer' },
    { name: 'regression', testDir: './tests/regression' },
  ],
})
