import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'
import { byTestId, SEL } from '../../lib/selectors.js'

test.describe.configure({ mode: 'serial' })

test('yields empty-state when no yield records exist', async ({ investorPage: page }) => {
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
