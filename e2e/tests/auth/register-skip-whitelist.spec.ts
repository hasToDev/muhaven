import { test, expect, chromium } from '@playwright/test'
import { byTestId, SEL } from '../../lib/selectors.js'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRESH_PROFILE = path.resolve(__dirname, '..', '..', 'profiles', 'register-skip')

/**
 * Uses a throwaway profile — this test registers a passkey that doesn't get
 * whitelisted, so the resulting smart account is useless for any downstream
 * test. Cleaning it up afterwards keeps the profiles/ dir tidy.
 */
test('register → Skip for now → redirect without whitelist', async () => {
  test.setTimeout(0)
  await rm(FRESH_PROFILE, { recursive: true, force: true })

  const ctx = await chromium.launchPersistentContext(FRESH_PROFILE, {
    headless: false,
    viewport: { width: 1400, height: 900 },
  })
  ctx.setDefaultTimeout(180_000)

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    const baseURL = process.env.E2E_BASE_URL ?? 'https://muhaven.app'
    await page.goto(`${baseURL}/login`)

    await byTestId(page, SEL.authModeToggle).click()
    await byTestId(page, SEL.authRoleInvestor).click({ force: true })
    await byTestId(page, SEL.authPasskeyNameInput).fill('E2E Skip Whitelist')
    await byTestId(page, SEL.authCta).click({ force: true })

    // Wait for the awaiting-whitelist screen.
    await byTestId(page, SEL.authDemoSkip).waitFor({ state: 'visible', timeout: 180_000 })

    // Skip.
    await byTestId(page, SEL.authDemoSkip).click()

    // Should redirect to /portfolio (investor default).
    await page.waitForURL(/\/portfolio/, { timeout: 300_000 })

    // Wallet pill visible — user IS authenticated, just not whitelisted.
    await expect(byTestId(page, SEL.navWalletPill)).toBeVisible()
  } finally {
    await ctx.close()
    await rm(FRESH_PROFILE, { recursive: true, force: true })
  }
})
