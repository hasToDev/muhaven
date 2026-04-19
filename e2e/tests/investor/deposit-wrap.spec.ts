import { roleTest as test, expect } from '../../lib/fixtures.js'
import { byTestId, SEL } from '../../lib/selectors.js'
import { WRAP_AMOUNT } from '../../lib/env.js'
import { testTreasuryBalance } from '../../lib/chain.js'
import { ensureInvestorReady } from '../../lib/ensure.js'

test.describe.configure({ mode: 'serial' })

test('vault wrap (ERC-20 → fhERC-20) → success card', async ({ investorPage: page }, testInfo) => {
  test.setTimeout(0)

  const address = await ensureInvestorReady(page, testInfo)
  const ttBalance = await testTreasuryBalance(address)
  const need = BigInt(WRAP_AMOUNT) * 10n ** 18n
  test.skip(
    ttBalance < need,
    `TestTreasury balance too low (have ${ttBalance}, need ${need}) — re-run setup-e2e to refund`,
  )

  await page.goto('/deposit')
  await byTestId(page, SEL.depositPathWrap).click({ force: true })

  await byTestId(page, SEL.depositAmountInput).fill(WRAP_AMOUNT)
  await byTestId(page, SEL.depositCta).click({ force: true })

  const success = byTestId(page, SEL.depositSuccessCard)
  const error = byTestId(page, SEL.depositErrorCard)

  await Promise.race([
    success.waitFor({ state: 'visible', timeout: 600_000 }),
    error.waitFor({ state: 'visible', timeout: 600_000 }),
  ])

  if (await error.isVisible().catch(() => false)) {
    const msg = (await error.innerText()).trim()
    throw new Error(`Wrap failed:\n${msg}`)
  }

  await expect(success).toBeVisible()
  await expect(page.getByText(/Vault Wrap Confirmed/i)).toBeVisible()
})
