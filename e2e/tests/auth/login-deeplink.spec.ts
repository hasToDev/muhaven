import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, logout, isAuthenticated } from '../../lib/auth.js'
import { byTestId, SEL } from '../../lib/selectors.js'

test.describe.configure({ mode: 'serial' })

test('logged-out navigation to /yields → login → land on /yields', async ({
  investorPage: page,
}) => {
  test.setTimeout(0)

  await page.goto('/')
  if (await isAuthenticated(page)) {
    await logout(page)
  }

  // Deep-link into a protected route while logged out.
  await page.goto('/yields')
  await page.waitForURL(/\/login/)
  const url = new URL(page.url())
  expect(url.searchParams.get('redirect')).toBe('/yields')

  // Complete login via the CTA on the redirected login page.
  await byTestId(page, SEL.authCta).click({ force: true })

  // Expect the redirect param to resolve to /yields.
  await page.waitForURL(/\/yields/, { timeout: 180_000 })
  expect(new URL(page.url()).pathname).toBe('/yields')
})
