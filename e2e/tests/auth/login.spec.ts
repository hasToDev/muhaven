import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, logout, isAuthenticated } from '../../lib/auth.js'

test.describe.configure({ mode: 'serial' })

test('login (investor profile) → redirect to /portfolio', async ({ investorPage: page }) => {
  test.setTimeout(0)

  // Ensure we start unauthenticated — if the persistent profile still holds
  // a JWT from a previous test, logout first.
  await page.goto('/')
  if (await isAuthenticated(page)) {
    await logout(page)
  }

  await login(page)
  expect(new URL(page.url()).pathname).toMatch(/\/portfolio/)
  expect(await isAuthenticated(page)).toBe(true)
})
