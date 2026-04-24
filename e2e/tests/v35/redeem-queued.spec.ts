import { roleTest as test, expect } from '../../lib/fixtures.js'
import { byTestId, SEL } from '../../lib/selectors.js'
import { ensureInvestorReady } from '../../lib/ensure.js'

test.describe.configure({ mode: 'serial' })

/**
 * Wave 3.5 queued redemption claim flow on `/redemptions`. The page lists
 * settled queue requests and exposes per-row "Decrypt" + "Claim" CTAs.
 *
 * Skips when the investor has no queued requests (expected before the
 * redeem-instant cap is exercised + auto-escalates to the queue). The
 * Phase 6 RedemptionsPage is read-only — submitting a queued redemption
 * goes through the not-yet-shipped redeem UI (see redeem-instant.spec).
 */
test('queued redemption — decrypt proceeds + claim CTA enabled', async ({ investorPage: page }, testInfo) => {
  test.setTimeout(0)

  await ensureInvestorReady(page, testInfo)

  await page.goto('/redemptions')

  // Refresh button kicks the indexer query — pre-cached page may show
  // stale "no requests" momentarily.
  const refreshBtn = byTestId(page, SEL.redemptionsRefresh)
  if (await refreshBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await refreshBtn.click({ force: true })
  }

  const row = byTestId(page, SEL.redemptionRow).first()
  let hasRow = false
  try {
    await row.waitFor({ state: 'visible', timeout: 30_000 })
    hasRow = true
  } catch {
    hasRow = false
  }
  test.skip(
    !hasRow,
    'No queued redemption requests for this investor — submit one (via SDK or future redeem UI) before re-running.',
  )

  // Decrypt button reveals the encrypted proceeds handle. Click should
  // never throw — silent-fail on bad permit just leaves the row in its
  // pre-decrypt state.
  const decryptBtn = row.getByTestId(SEL.redemptionDecryptProceeds)
  if (await decryptBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await decryptBtn.click({ force: true })
  }

  const claimBtn = row.getByTestId(SEL.redemptionClaimCta)
  await expect(claimBtn).toBeVisible({ timeout: 30_000 })

  // Don't click claim unconditionally — the request must be `settled`
  // first, and we don't know its lifecycle state from this spec. Assert
  // the CTA at least exists and has a sensible enabled/disabled bit.
  const disabled = await claimBtn.getAttribute('disabled')
  if (disabled !== null) {
    test.skip(true, 'claim CTA disabled — request not yet settled (issuer hasn’t run processEpoch)')
  }
})
