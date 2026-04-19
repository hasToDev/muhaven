import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'
import { byTestId, SEL } from '../../lib/selectors.js'

test.describe.configure({ mode: 'serial' })

/**
 * Opportunistic — asserts the disabled-claim UX when a row has a null
 * `escrow_id`. Requires the backend to surface such a row; skipped if the
 * poller has caught up on all records.
 */
test('claim disabled when escrow_id is null', async ({ investorPage: page }) => {
  test.setTimeout(0)

  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }

  await page.goto('/yields')

  // Wait up to 90s for at least one claim button to render — the yields page
  // is async (backend fetch + store load), and `locator.count()` returns
  // synchronously so calling it immediately after `goto` reliably finds zero.
  try {
    await page.getByTestId(SEL.yieldsClaimCta).first().waitFor({ state: 'visible', timeout: 90_000 })
  } catch {
    // No claim rows rendered — handled by the skip below.
  }
  const claimBtns = page.getByTestId(SEL.yieldsClaimCta)
  const count = await claimBtns.count()
  test.skip(count === 0, 'no claimable rows to inspect')

  let disabledBtnIdx = -1
  for (let i = 0; i < count; i++) {
    const disabled = await claimBtns.nth(i).getAttribute('disabled')
    if (disabled !== null) {
      disabledBtnIdx = i
      break
    }
  }
  test.skip(
    disabledBtnIdx === -1,
    'all claim buttons are enabled — no null-escrow row to test',
  )

  await claimBtns.nth(disabledBtnIdx).click({ force: true })
  await expect(page.getByText(/Claim unavailable/i)).toBeVisible({ timeout: 5_000 })
})
