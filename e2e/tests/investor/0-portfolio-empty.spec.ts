import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'

/**
 * Deferred — requires a fresh investor profile that has never minted. Once
 * the wallet has been used for any deposit (same run or prior), the test
 * can't reach the empty state. The portfolio store can also stall in
 * `loaded === false` mode rendering neither empty-state nor holding cards,
 * which makes the built-in `hasHoldings` skip guard unreliable.
 *
 * Implementing this in the full-suite run would need a dedicated
 * `profiles/investor-empty/` with its own register + setup-e2e bootstrap —
 * tracked as Phase 20.D post-hackathon. Until then the spec is `test.fixme`
 * and must be invoked manually against a freshly-registered investor wallet
 * BEFORE any deposit runs.
 */
test.fixme('portfolio empty state (pre-deposit)', async ({ investorPage: page }) => {
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
