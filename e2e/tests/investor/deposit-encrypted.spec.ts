import { roleTest as test, expect } from '../../lib/fixtures.js'
import { byTestId, SEL } from '../../lib/selectors.js'
import { DEPOSIT_AMOUNT } from '../../lib/env.js'
import { ensureInvestorReady } from '../../lib/ensure.js'

test.describe.configure({ mode: 'serial' })

test('encrypted mint deposit → success card with tx hash', async ({ investorPage: page }, testInfo) => {
  test.setTimeout(0)

  await ensureInvestorReady(page, testInfo)

  await page.goto('/deposit')

  // Ensure the encrypted-mint path is selected.
  await byTestId(page, SEL.depositPathEncrypted).click({ force: true })

  // Pick the first token if a dropdown is visible.
  const tokenSelect = byTestId(page, SEL.depositTokenSelect)
  if (await tokenSelect.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const values = await tokenSelect
      .locator('option')
      .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value).filter(Boolean))
    if (values.length > 0) await tokenSelect.selectOption(values[0])
  }

  // Fill amount + submit.
  await byTestId(page, SEL.depositAmountInput).fill(DEPOSIT_AMOUNT)
  await byTestId(page, SEL.depositCta).click({ force: true })

  // Wait for the success card OR error card. If it's the error we fail loudly.
  const success = byTestId(page, SEL.depositSuccessCard)
  const error = byTestId(page, SEL.depositErrorCard)

  await Promise.race([
    success.waitFor({ state: 'visible', timeout: 600_000 }),
    error.waitFor({ state: 'visible', timeout: 600_000 }),
  ])

  if (await error.isVisible().catch(() => false)) {
    const msg = (await error.innerText()).trim()
    throw new Error(`Deposit failed:\n${msg}`)
  }

  await expect(success).toBeVisible()

  // Success card contains the Arbiscan tx link.
  const txLink = page.getByRole('link', { name: /0x[a-fA-F0-9]{8}\.\.\.[a-fA-F0-9]{8}/ })
  await expect(txLink).toBeVisible({ timeout: 10_000 })
})
