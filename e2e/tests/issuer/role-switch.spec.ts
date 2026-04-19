import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'
import { byTestId, SEL } from '../../lib/selectors.js'

test.describe.configure({ mode: 'serial' })

test('role switch issuer → investor → issuer', async ({ issuerPage: page }) => {
  test.setTimeout(0)

  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }
  await page.goto('/tokens')

  // Switch to investor.
  await byTestId(page, SEL.navRoleInvestor).click()
  await page.waitForURL(/\/portfolio/, { timeout: 180_000 })
  // Investor nav items visible.
  await expect(page.getByRole('link', { name: /Portfolio/i })).toBeVisible()

  // Switch back to issuer.
  await byTestId(page, SEL.navRoleIssuer).click()
  await page.waitForURL(/\/tokens/, { timeout: 180_000 })
  await expect(page.getByRole('link', { name: /Distribute/i })).toBeVisible()
})
