import { roleTest as test, expect } from '../../lib/fixtures.js'
import { byTestId, SEL } from '../../lib/selectors.js'
import { ensureIssuerReady } from '../../lib/ensure.js'

test.describe.configure({ mode: 'serial' })

test('distribute pre-flight — insufficient PUSDC surfaces actionable error', async ({
  issuerPage: page,
}, testInfo) => {
  test.setTimeout(0)

  await ensureIssuerReady(page, testInfo)

  // Deliberately large amount — well beyond any realistic test PUSDC balance —
  // so the "insufficient" branch fires regardless of current state. Using the
  // on-chain `balanceOf` to compute a 10x is unreliable (it's a pseudo-random
  // indicator, not the real balance).
  const human = '1000000'

  await page.goto('/distribute')

  // Select any active token.
  const tokenSelect = byTestId(page, SEL.distributeTokenSelect)
  const values = await tokenSelect
    .locator('option')
    .evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value).filter(Boolean),
    )
  test.skip(values.length === 0, 'no active tokens to distribute against')
  await tokenSelect.selectOption(values[0])

  await byTestId(page, SEL.distributeAmountInput).fill(human)
  await byTestId(page, SEL.distributeCta).click({ force: true })

  await expect(page.getByText(/Insufficient PUSDC/i)).toBeVisible({ timeout: 30_000 })
  await expect(byTestId(page, SEL.distributeError)).toBeVisible()
})
