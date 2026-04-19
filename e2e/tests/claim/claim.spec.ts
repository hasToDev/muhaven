import { roleTest as test, expect } from '../../lib/fixtures.js'
import { byTestId, SEL } from '../../lib/selectors.js'
import { ensureInvestorReady } from '../../lib/ensure.js'

test.describe.configure({ mode: 'serial' })

test('claim yield → toast + row flips claimable→claimed', async ({ investorPage: page }, testInfo) => {
  test.setTimeout(0)

  await ensureInvestorReady(page, testInfo)

  await page.goto('/yields')

  // `locator.isVisible({ timeout })` is synchronous in practice — it does NOT
  // auto-retry within the timeout window, so a skip check written that way
  // fires instantly on a slow-loading page. Use `waitFor` to actually poll,
  // giving the backend poller up to 90s to flip yield records from
  // `pending` → `claimable` after a prior distribute.
  const row = byTestId(page, SEL.yieldsClaimRow).first()
  let hasClaimable = false
  try {
    await row.waitFor({ state: 'visible', timeout: 90_000 })
    hasClaimable = true
  } catch {
    hasClaimable = false
  }
  test.skip(
    !hasClaimable,
    'no claimable yields after 90s — run issuer/distribute.spec.ts against this investor first, or wait for the backend poller to catch up',
  )

  const claimBtn = row.getByTestId(SEL.yieldsClaimCta)

  // Ensure the claim button is enabled (escrow_id resolved) before clicking.
  const disabled = await claimBtn.getAttribute('disabled')
  test.skip(disabled !== null, 'claim button disabled — escrow_id not yet indexed by poller')

  const recordId = await row.getAttribute('data-record-id')

  await claimBtn.click({ force: true })

  // Toast "Claim submitted — tx 0x..."
  await expect(page.getByText(/Claim submitted/i)).toBeVisible({ timeout: 120_000 })

  // Backend poller flips the record to `claimed` within ~22s (frontend also
  // waits 22s inside claimYield before refetching) — give it 60s to be safe.
  //
  // `data-record-id` lives on the row element itself, NOT on a child — so we
  // match via a compound attribute selector instead of `.filter({ has })`.
  await expect(async () => {
    await page.reload()
    const rowAfter = page.locator(
      `[data-testid="${SEL.yieldsClaimRow}"][data-record-id="${recordId}"]`,
    )
    const stillClaimable = await rowAfter.first().isVisible({ timeout: 1_000 }).catch(() => false)
    expect(stillClaimable).toBe(false)
  }).toPass({ timeout: 60_000 })
})
