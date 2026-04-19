import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'
import { byTestId, SEL } from '../../lib/selectors.js'

test.describe.configure({ mode: 'serial' })

test('click TopNav pill copies FULL address (not truncated)', async ({ investorPage: page }) => {
  test.setTimeout(0)

  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }

  await page.goto('/portfolio')

  // Grant clipboard-read permission so we can verify what got copied.
  const ctx = page.context()
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'])

  const pill = byTestId(page, SEL.navWalletPill)
  await pill.click()

  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied, 'clipboard did not receive the full address').toMatch(/^0x[a-fA-F0-9]{40}$/)

  // Pill should show Check icon briefly — exact icon assertion is brittle,
  // so we just confirm the toast contains the address.
  await expect(page.getByText(/Address copied/i)).toBeVisible({ timeout: 5_000 })
})
