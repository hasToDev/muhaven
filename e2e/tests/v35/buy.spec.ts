import { roleTest as test, expect } from '../../lib/fixtures.js'
import { byTestId, SEL } from '../../lib/selectors.js'
import { ensureInvestorReady } from '../../lib/ensure.js'

test.describe.configure({ mode: 'serial' })

/**
 * Wave 3.5 atomic purchase via `MuHavenSubscription.purchase`. Skips
 * cleanly when the staging env hasn't yet onboarded a Wave 3.5 token —
 * surfacing as "no buyable assets" lets the spec stay green pre-Phase-8
 * cutover.
 */
test('buy via Subscription → success card', async ({ investorPage: page }, testInfo) => {
  test.setTimeout(0)

  await ensureInvestorReady(page, testInfo)

  await page.goto('/buy')

  // BuyPage renders <select data-testid="buy-token-select"> only when at
  // least one Wave 3.5 token is registered. Absence = nothing to buy.
  const tokenSelect = byTestId(page, SEL.buyTokenSelect)
  let hasTokens = false
  try {
    await tokenSelect.waitFor({ state: 'visible', timeout: 15_000 })
    hasTokens = true
  } catch {
    hasTokens = false
  }
  test.skip(
    !hasTokens,
    'No Wave 3.5 tokens onboarded in this env — buy spec is a no-op until Phase 8 onboards TBILL1/GOLD1',
  )

  // Pick the first available token. Some envs ship TBILL1 + GOLD1; the spec
  // doesn't care which one, only that at least one is buyable.
  const values = await tokenSelect
    .locator('option')
    .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value).filter(Boolean))
  expect(values.length, 'buy-token-select rendered with no options — registry empty?').toBeGreaterThan(0)
  await tokenSelect.selectOption(values[0])

  // KYC blocked = the IdentityRegistry hasn't recognised this profile yet
  // (e.g. dev-mode off and no whitelist entry). Skip rather than fail —
  // identity onboarding is exercised elsewhere.
  const kycBlocked = await byTestId(page, SEL.buyKycBlocked).isVisible({ timeout: 1_000 }).catch(() => false)
  test.skip(kycBlocked, 'IdentityRegistry rejected this profile — re-run identity onboarding before this spec')

  // Stale NAV → on-chain `purchase` will revert. Skip with a clear message
  // rather than chasing a synthetic "expected to fail" path.
  const navReadout = byTestId(page, SEL.buyNavReadout)
  if (await navReadout.isVisible({ timeout: 1_000 }).catch(() => false)) {
    const text = (await navReadout.innerText()).trim()
    test.skip(/stale/i.test(text), 'NAV stale — purchase would revert. Re-run NAV cron then retry.')
  }

  await byTestId(page, SEL.buyAmountInput).fill('1')
  await byTestId(page, SEL.buyCta).click({ force: true })

  const success = byTestId(page, SEL.buySuccessCard)
  const errorCard = byTestId(page, SEL.buyErrorCard)

  await Promise.race([
    success.waitFor({ state: 'visible', timeout: 600_000 }),
    errorCard.waitFor({ state: 'visible', timeout: 600_000 }),
  ])

  if (await errorCard.isVisible().catch(() => false)) {
    const msg = (await errorCard.innerText()).trim()
    throw new Error(`Buy failed:\n${msg}`)
  }

  await expect(success).toBeVisible()
})
