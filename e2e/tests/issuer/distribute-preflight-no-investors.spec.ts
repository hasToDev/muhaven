import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'
import { byTestId, SEL } from '../../lib/selectors.js'
import { DISTRIBUTE_AMOUNT } from '../../lib/env.js'
import { investorCount } from '../../lib/chain.js'

test.describe.configure({ mode: 'serial' })

/**
 * Only runnable against a fresh deployment where `InvestorRegistry.investorCount()`
 * is still zero. Skipped on the normal Arb Sepolia deployment where investors
 * already exist.
 */
test('distribute pre-flight — no investors surfaces actionable error', async ({
  issuerPage: page,
}) => {
  test.setTimeout(0)

  const count = await investorCount()
  test.skip(
    count > 0n,
    `registry already has ${count} investors — no-investor precondition unreachable`,
  )

  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }

  await page.goto('/distribute')

  await byTestId(page, SEL.distributeAmountInput).fill(DISTRIBUTE_AMOUNT)
  await byTestId(page, SEL.distributeCta).click({ force: true })

  await expect(page.getByText(/No registered investors/i)).toBeVisible({ timeout: 30_000 })

  // No receipt, no biometric prompt fired — failure card visible instead.
  await expect(byTestId(page, SEL.distributeError)).toBeVisible()
})
