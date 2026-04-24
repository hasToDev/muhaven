import { test, expect } from '@playwright/test'

const PROTECTED_ROUTES = [
  '/portfolio',
  '/marketplace',
  '/trade',
  '/deposit',
  '/yields',
  '/activity',
  '/tokens',
  '/distribute',
  '/investors',
  '/compliance',
  '/agent',
] as const

test.describe('router guard (unauthenticated)', () => {
  for (const path of PROTECTED_ROUTES) {
    test(`${path} redirects to /login?redirect=${path}`, async ({ page }) => {
      await page.goto(path)
      await page.waitForURL(/\/login/, { timeout: 300_000 })
      const url = new URL(page.url())
      expect(url.pathname).toBe('/login')
      expect(url.searchParams.get('redirect')).toBe(path)
    })
  }

  test('public routes are reachable without auth', async ({ page }) => {
    for (const path of ['/', '/login']) {
      await page.goto(path)
      expect(new URL(page.url()).pathname).toBe(path)
    }
  })
})
