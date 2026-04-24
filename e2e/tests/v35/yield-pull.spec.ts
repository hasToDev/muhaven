import { roleTest as test, expect } from '../../lib/fixtures.js'
import { byTestId, SEL } from '../../lib/selectors.js'
import { ensureInvestorReady } from '../../lib/ensure.js'

test.describe.configure({ mode: 'serial' })

/**
 * Wave 3.5 epoch-based pull yield claim on `/yields`. The page renders
 * one row per funded epoch the investor was snapshotted in. Skips when no
 * epochs are claimable (issuer hasn't run snapshot/finalize/fund), or
 * when the row exists but its CTA is disabled (already claimed).
 *
 * Lives alongside the Wave 3 legacy claim spec (`tests/claim/claim.spec.ts`)
 * — both should pass green during the Wave 3 → Wave 3.5 transition.
 */
test('claim yield via YieldSnapshot epoch → row + CTA', async ({ investorPage: page }, testInfo) => {
  test.setTimeout(0)

  await ensureInvestorReady(page, testInfo)

  await page.goto('/yields')

  // YieldsPage shows Wave 3.5 epoch rows when any are present, with
  // Wave 3 legacy distributions below. Empty state means neither pipeline
  // has produced a claimable record yet.
  const epochRow = byTestId(page, SEL.epochRow).first()
  let hasEpoch = false
  try {
    await epochRow.waitFor({ state: 'visible', timeout: 30_000 })
    hasEpoch = true
  } catch {
    hasEpoch = false
  }
  test.skip(
    !hasEpoch,
    'No funded epochs available — issuer needs to openEpoch → snapshotBatch → finalize → fundEpoch first.',
  )

  const claimBtn = epochRow.getByTestId(SEL.epochClaimCta)
  await expect(claimBtn).toBeVisible({ timeout: 15_000 })

  // Already-claimed rows leave the CTA in a disabled state — that's a
  // green-path skip, not a failure.
  const disabled = await claimBtn.getAttribute('disabled')
  test.skip(disabled !== null, 'Epoch already claimed — re-run after a fresh fundEpoch.')

  await claimBtn.click({ force: true })

  // Toast / status bubble. The success path keeps the row visible but
  // flips the CTA to "Claimed" — assert one or the other within ~2 min.
  await expect(async () => {
    const stillEnabled = await epochRow
      .getByTestId(SEL.epochClaimCta)
      .getAttribute('disabled')
    expect(stillEnabled, 'epoch CTA never flipped to disabled after claim').not.toBeNull()
  }).toPass({ timeout: 120_000 })
})
