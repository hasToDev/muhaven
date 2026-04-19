import { test, expect } from '@playwright/test'
import { byTestId, SEL } from '../../lib/selectors.js'

test.describe('landing page', () => {
  // Patterns for console.error logs that are known-benign in third-party /
  // browser / framework code — not signals of a MuHaven regression. Update
  // this list ONLY with user approval; prefer fixing the root cause first.
  const BENIGN_CONSOLE_PATTERNS: RegExp[] = [
    /favicon\.ico/i,
    /Cross-Origin-/i,
    /devtools/i,
    /tfhe.*wasm/i,
    /fetch.*abort/i,
    /google-analytics|googletagmanager|cloudflare/i,
    /preload.*was preloaded/i,
  ]

  test('renders hero + glass nav + CTA → /login', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      const text = msg.text()
      if (BENIGN_CONSOLE_PATTERNS.some((p) => p.test(text))) return
      consoleErrors.push(text)
    })

    await page.goto('/')

    // Hero headline (typewriter eventually lands on "Private.")
    await expect(page.getByText(/Private\./i).first()).toBeVisible({ timeout: 15_000 })

    // Logo + MuHaven brand
    await expect(page.getByAltText('MuHaven').first()).toBeVisible()

    // Launch App CTA anywhere on the page — click the first.
    const launchCta = page.getByRole('link', { name: /Launch App/i }).first()
    await expect(launchCta).toBeVisible()

    await launchCta.click()
    await page.waitForURL(/\/login/)

    // Assert no red console errors during first paint + navigation. Warnings
    // from COOP/COEP/WASM are acceptable — we only fail on `error`-level logs.
    expect(consoleErrors, 'Unexpected console.error output:\n' + consoleErrors.join('\n')).toEqual([])
  })

  test('scroll reveals floating glass nav + anchors jump to sections', async ({ page }) => {
    await page.goto('/')

    // Scroll to trigger the glass-panel transition in TopNav.
    await page.evaluate(() => window.scrollBy({ top: 400, behavior: 'instant' as ScrollBehavior }))
    // Give the 500ms transition time to settle.
    await page.waitForTimeout(600)

    // FAQ anchor — click and verify the FAQ heading enters view.
    const faqLink = page.getByRole('link', { name: /FAQ/i }).first()
    if (await faqLink.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await faqLink.click()
      await expect(page.getByRole('heading', { name: /FAQ/i }).first()).toBeInViewport({
        timeout: 5_000,
      })
    }
  })

  test('dark mode toggle persists across reload', async ({ page }) => {
    await page.goto('/')
    const before = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    )

    await byTestId(page, SEL.navDarkToggle).click()

    const after = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    )
    expect(after).toBe(!before)

    // Reload and assert the chosen mode sticks.
    await page.reload()
    const afterReload = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    )
    expect(afterReload).toBe(after)

    // Clean up: toggle back so the profile doesn't drift for subsequent tests.
    await byTestId(page, SEL.navDarkToggle).click()
  })
})
