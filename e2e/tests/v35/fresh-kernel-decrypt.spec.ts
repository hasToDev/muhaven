import { roleTest as test, expect } from '../../lib/fixtures.js'
import { byTestId, SEL } from '../../lib/selectors.js'
import { ensureInvestorReady } from '../../lib/ensure.js'

test.describe.configure({ mode: 'serial' })

/**
 * Wave 3.5 Phase 7 — fresh-kernel / fresh-session decrypt.
 *
 * Every page reload regenerates the in-memory ephemeral EOA (see
 * `frontend/src/composables/useFhe.ts` — `ephemeralPrivateKey` is module-
 * level, wiped on reload). After a reload, any balance handle whose ACL
 * was granted to yesterday's EOA will 403 on `decryptForView`.
 *
 * Phase 7 added two complementary paths to close that gap:
 *   1. Contract — `MuHavenToken.refreshDecryptGrant(ephemeralEOA)` lets
 *      the balance holder self-re-bind ACL on their own current handle.
 *   2. Frontend — `useFhe.decryptForView` auto-fires the refresh on a
 *      first-decrypt 403 and retries once before surfacing the error.
 *
 * This spec proves the auto-refresh works end-to-end:
 *   - Investor already holds a decryptable fhERC-20 balance (test skips
 *     if they don't — they can earn one via `buy.spec.ts`).
 *   - Page is reloaded → fresh ephemeral EOA.
 *   - Clicking "Decrypt" on the Portfolio holding succeeds WITHOUT the
 *     tester intervening on any retry banner — the auto-refresh runs
 *     silently as one UserOp.
 *
 * Skips cleanly when no Wave 3.5 fhERC-20 balance is detectable on the
 * investor profile (fresh staging envs / pre-Phase-8 onboarding).
 */
test('fresh session → portfolio balance decrypt auto-refreshes ACL', async ({ investorPage: page }, testInfo) => {
  test.setTimeout(0)

  await ensureInvestorReady(page, testInfo)

  // Visit Portfolio once to ensure the investor has at least one holding
  // card rendered. If nothing rendered, skip — nothing to decrypt.
  await page.goto('/portfolio')

  const holdingCard = byTestId(page, SEL.portfolioHoldingCard).first()
  let hasHoldings = false
  try {
    await holdingCard.waitFor({ state: 'visible', timeout: 15_000 })
    hasHoldings = true
  } catch {
    hasHoldings = false
  }
  test.skip(
    !hasHoldings,
    'Investor has no Wave 3.5 holdings — buy.spec needs to run first or Phase 8 onboarding is incomplete.',
  )

  // Force a fresh ephemeral EOA by reloading. The Vue app module-state
  // resets, so the in-memory `ephemeralPrivateKey` in useFhe.ts is
  // regenerated on next init.
  await page.reload()
  await holdingCard.waitFor({ state: 'visible', timeout: 15_000 })

  // Click Decrypt on the first card. The auto-refresh should fire on a
  // 403, issue one UserOp via the kernel to call `refreshDecryptGrant`,
  // and retry — ending with a decrypted number on screen.
  const decryptBtn = byTestId(page, SEL.portfolioDecryptCta).first()
  await decryptBtn.waitFor({ state: 'visible', timeout: 10_000 })

  // If the card is already decrypted (rare — would mean module state
  // survived the reload, which shouldn't happen but could on a
  // pre-existing cache), the button won't render. Skip rather than fail.
  if (!(await decryptBtn.isVisible().catch(() => false))) {
    test.skip(true, 'First holding already decrypted — post-reload state unexpected, spec unreliable.')
    return
  }

  await decryptBtn.click({ force: true })

  // A successful decrypt flips the button away — the holding card starts
  // showing a number instead of the "Decrypt" CTA. We give it ample time
  // because the refresh path is 1 UserOp + 1 decrypt (~60s on staging).
  await expect(decryptBtn).toBeHidden({ timeout: 180_000 })
})
