import { roleTest as test, expect } from '../../lib/fixtures.js'
import { byTestId, SEL } from '../../lib/selectors.js'
import { ensureInvestorReady } from '../../lib/ensure.js'

test.describe.configure({ mode: 'serial' })

/**
 * Wave 3.5 instant redemption via `MuHavenSubscription.redeem`.
 *
 * The Wave 3.5 frontend sub-phase shipped BuyPage but did NOT add an
 * instant-redeem CTA — the redeem flow is currently exercised through the
 * SDK + scripts, not the dashboard. This spec is a placeholder that skips
 * with a clear marker pending the redeem-UI sub-phase. Keeping the spec
 * file in place means the suite count matches the plan and Phase 7's
 * fresh-kernel decrypt audit has a slot to land into.
 */
test.fixme('redeem instant via Subscription → success card', async ({ investorPage: page }, testInfo) => {
  test.setTimeout(0)
  await ensureInvestorReady(page, testInfo)

  await page.goto('/buy')

  // When the redeem-mode toggle ships, this spec should:
  //   1. Click the redeem-mode toggle on /buy (or navigate to /redeem).
  //   2. Pick a token the investor already holds.
  //   3. Fill an amount that fits inside the per-token instant cap.
  //   4. Submit and wait for the success card.
  // For now, document that the UI doesn't exist.
  expect(true).toBe(true)
})
