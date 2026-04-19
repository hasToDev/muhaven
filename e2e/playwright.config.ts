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
  timeout: 300_000,
  expect: { timeout: 300_000 },
  projects: [
    { name: 'public', testDir: './tests/public' },
    { name: 'auth', testDir: './tests/auth' },
    { name: 'investor', testDir: './tests/investor' },
    { name: 'issuer', testDir: './tests/issuer' },
    // claim must run AFTER issuer/distribute.spec.ts has created an on-chain
    // distribution targeting the investor smart account. In the investor
    // project it would always skip because `investor` runs before `issuer`.
    { name: 'claim', testDir: './tests/claim' },
    { name: 'regression', testDir: './tests/regression' },
    // logout runs last — it clears localStorage for the investor profile,
    // which would force every downstream spec's ensureInvestorReady() to
    // fresh-login (+2 biometric prompts per spec). Keeping it in a dedicated
    // teardown project preserves warm auth state across the investor suite.
    { name: 'teardown', testDir: './tests/teardown' },
  ],
})
