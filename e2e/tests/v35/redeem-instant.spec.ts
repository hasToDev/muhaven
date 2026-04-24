import { roleTest as test, expect } from '../../lib/fixtures.js'
import { byTestId, SEL } from '../../lib/selectors.js'
import { ensureInvestorReady } from '../../lib/ensure.js'

test.describe.configure({ mode: 'serial' })

/**
 * Wave 3.5 instant redemption via `MuHavenSubscription.redeem` driven from
 * the `/trade` Sell-mode toggle (Phase 6.5).
 *
 * Skips when the staging env hasn't yet onboarded a Wave 3.5 token, when
 * the investor has no decryptable holdings, or when the per-token instant
 * cap is empty (which would force escalate-to-queue and is exercised by
 * `redeem-queued.spec.ts`).
 */
test('redeem instant via Subscription → success card', async ({ investorPage: page }, testInfo) => {
  test.setTimeout(0)

  await ensureInvestorReady(page, testInfo)

  await page.goto('/trade')

  // Toggle to Sell mode. The button is disabled while a tx is in flight,
  // but on a fresh page load it should be clickable immediately.
  const sellToggle = byTestId(page, SEL.tradeModeSell)
  await sellToggle.waitFor({ state: 'visible', timeout: 15_000 })
  await sellToggle.click({ force: true })

  // Token select renders only when at least one Wave 3.5 token is in the
  // marketplace registry. Skip when empty — same shape as buy.spec.
  const tokenSelect = byTestId(page, SEL.sellTokenSelect)
  let hasTokens = false
  try {
    await tokenSelect.waitFor({ state: 'visible', timeout: 15_000 })
    hasTokens = true
  } catch {
    hasTokens = false
  }
  test.skip(!hasTokens, 'No Wave 3.5 tokens onboarded — redeem spec is a no-op until Phase 8')

  // Reveal the holding so we know the upper bound. Skip if zero — without
  // a position there's nothing to redeem.
  await byTestId(page, SEL.sellRevealBalance).click({ force: true })
  const holdingReadout = byTestId(page, SEL.sellHoldingReadout)
  await expect(holdingReadout).toBeVisible({ timeout: 30_000 })
  const holdingText = (await holdingReadout.innerText()).trim()
  const holdingNum = parseInt(holdingText.replace(/[^\d]/g, ''), 10)
  test.skip(
    !Number.isFinite(holdingNum) || holdingNum <= 0,
    'No decryptable holdings on this token for the investor — buy first or pick a different fixture',
  )

  // Pick a small amount that will fit inside the instant cap. The amber
  // escalate-warning is the contract telling us this would queue — skip
  // the instant assertion in that case (covered by redeem-queued spec).
  await byTestId(page, SEL.sellAmountInput).fill('1')

  const willEscalate = await byTestId(page, SEL.sellEscalateWarning)
    .isVisible({ timeout: 1_000 })
    .catch(() => false)
  test.skip(
    willEscalate,
    'Instant cap exhausted this epoch — would escalate to queue. Covered by redeem-queued.spec',
  )

  await byTestId(page, SEL.redeemCta).click({ force: true })

  const success = byTestId(page, SEL.redeemInstantSuccessCard)
  const errorCard = byTestId(page, SEL.redeemErrorCard)

  await Promise.race([
    success.waitFor({ state: 'visible', timeout: 600_000 }),
    errorCard.waitFor({ state: 'visible', timeout: 600_000 }),
  ])

  if (await errorCard.isVisible().catch(() => false)) {
    const msg = (await errorCard.innerText()).trim()
    throw new Error(`Instant redeem failed:\n${msg}`)
  }

  await expect(success).toBeVisible()
  await expect(page.getByText(/Redemption confirmed/i)).toBeVisible()
})
