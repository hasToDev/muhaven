import { roleTest as test, expect } from '../../lib/fixtures.js'
import { byTestId, SEL } from '../../lib/selectors.js'
import { DISTRIBUTE_AMOUNT } from '../../lib/env.js'
import { distributionCount } from '../../lib/chain.js'
import { ensureIssuerReady } from '../../lib/ensure.js'

test.describe.configure({ mode: 'serial' })

test('distribute yield pipeline → receipt + on-chain count increments', async ({
  issuerPage: page,
}, testInfo) => {
  test.setTimeout(0)

  await ensureIssuerReady(page, testInfo)

  const countBefore = await distributionCount()

  await page.goto('/distribute')

  // Select first active token.
  const tokenSelect = byTestId(page, SEL.distributeTokenSelect)
  await tokenSelect.waitFor({ state: 'visible', timeout: 15_000 })
  const values = await tokenSelect
    .locator('option')
    .evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value).filter((v) => v),
    )
  expect(values.length, 'no active tokens available to distribute').toBeGreaterThan(0)
  await tokenSelect.selectOption(values[0])

  await byTestId(page, SEL.distributeAmountInput).fill(DISTRIBUTE_AMOUNT)
  await byTestId(page, SEL.distributeCta).click({ force: true })

  const receipt = byTestId(page, SEL.distributeReceipt)
  const error = byTestId(page, SEL.distributeError)

  await Promise.race([
    receipt.waitFor({ state: 'visible', timeout: 600_000 }),
    error.waitFor({ state: 'visible', timeout: 600_000 }),
  ])

  if (await error.isVisible().catch(() => false)) {
    const msg = (await error.innerText()).trim()
    throw new Error(`Distribution failed:\n${msg}`)
  }

  // Receipt contains a distribution ID.
  const idText = await byTestId(page, SEL.distributeReceiptId).innerText()
  expect(idText).toMatch(/^#\d+/)

  // On-chain verification.
  const countAfter = await distributionCount()
  expect(
    countAfter,
    `distributionCount did not increase (before=${countBefore}, after=${countAfter})`,
  ).toBeGreaterThan(countBefore)
})
