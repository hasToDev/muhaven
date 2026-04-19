import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, logout, isAuthenticated } from '../../lib/auth.js'

test.describe.configure({ mode: 'serial' })

test('logout clears localStorage + protected route redirects again', async ({
  investorPage: page,
}) => {
  test.setTimeout(0)

  // Ensure we're authed first.
  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }

  // Sanity: the auth-tokens entry is non-empty pre-logout.
  // Keys verified against frontend/src/services/api.ts:8 (`muhaven-auth-tokens`)
  // and frontend/src/stores/wallet.ts:6 (`muhaven-wallet`).
  const preAuth = await page.evaluate(() => localStorage.getItem('muhaven-auth-tokens'))
  expect(preAuth, 'pre-logout auth tokens empty — test pre-condition failed').toBeTruthy()

  await logout(page)

  // After logout: URL is /login, and the auth-specific localStorage keys are cleared.
  expect(new URL(page.url()).pathname).toBe('/login')

  const postAuth = await page.evaluate(() => localStorage.getItem('muhaven-auth-tokens'))
  const postWallet = await page.evaluate(() => localStorage.getItem('muhaven-wallet'))
  expect(postAuth).toBeNull()
  expect(postWallet).toBeNull()

  // Protected route redirects again.
  await page.goto('/portfolio')
  await page.waitForURL(/\/login\?redirect=\/portfolio/)
})
