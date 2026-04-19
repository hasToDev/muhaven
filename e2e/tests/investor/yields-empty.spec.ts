import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'
import { byTestId, SEL } from '../../lib/selectors.js'

test.describe.configure({ mode: 'serial' })

/**
 * Deferred — same `test.fixme` pattern as `0-portfolio-empty.spec.ts`. The
 * warm investor wallet already has yield records from prior `distribute.spec.ts`
 * runs (records are on-chain / in the backend DB and persist across e2e runs),
 * plus the `yieldsClaimRow` visibility guard is unreliable when the /yields
 * page is still loading its records list. Implementing a true empty-state
 * test needs a dedicated `profiles/investor-empty/` that has never been
 * targeted by a distribute. Tracked as Phase 20.D post-hackathon.
 */
test.fixme('yields empty-state when no yield records exist', async ({ investorPage: page }) => {
  test.setTimeout(0)

  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }

  await page.goto('/yields')

  const hasClaimRow = await byTestId(page, SEL.yieldsClaimRow)
    .first()
    .isVisible({ timeout: 3_000 })
    .catch(() => false)
  test.skip(
    hasClaimRow,
    'account already has claimable yields — empty-state not reachable',
  )

  // History empty message.
  await expect(page.getByText(/No yield records yet/i)).toBeVisible()

  // Summary cards render with zeros.
  await expect(page.getByText(/Total Earned/i)).toBeVisible()
  await expect(page.getByText(/Pending/i).first()).toBeVisible()
})
