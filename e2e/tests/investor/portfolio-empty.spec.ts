import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'

/**
 * Runs only if the investor profile has no holdings yet. When the suite runs
 * end-to-end, deposit-encrypted.spec.ts mints before any portfolio pages are
 * visited — so this test is skipped once the account has a holding.
 *
 * To verify the empty-state explicitly, run with a fresh investor profile
 * BEFORE running deposit-encrypted.spec.ts.
 */
test('portfolio empty state (pre-deposit)', async ({ investorPage: page }) => {
  test.setTimeout(0)

  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }

  await page.goto('/portfolio')

  const hasHoldings = await page
    .getByTestId('portfolio-holding-card')
    .first()
    .isVisible({ timeout: 3_000 })
    .catch(() => false)

  test.skip(hasHoldings, 'account already has holdings — empty-state not reachable')

  await expect(page.getByText(/No holdings yet/i)).toBeVisible()

  const depositCta = page.getByRole('link', { name: /Make a Deposit/i })
  await expect(depositCta).toBeVisible()
  await depositCta.click()
  await page.waitForURL(/\/deposit/)
})
