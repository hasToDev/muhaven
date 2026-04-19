import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'
import { byTestId, SEL } from '../../lib/selectors.js'

test.describe.configure({ mode: 'serial' })

test('distribute — reveal confidential PUSDC + refresh hides', async ({ issuerPage: page }) => {
  test.setTimeout(0)

  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }

  await page.goto('/distribute')

  const reveal = byTestId(page, SEL.distributeRevealConfidential)
  const visible = await reveal.isVisible({ timeout: 15_000 }).catch(() => false)
  test.skip(
    !visible,
    'Reveal confidential not rendered — issuer has no PUSDC balance at all',
  )

  await reveal.click({ force: true })

  // After reveal, the "Confidential portion" label appears.
  await expect(page.getByText(/Confidential portion/i)).toBeVisible({ timeout: 120_000 })

  // Click refresh — hides confidential + re-fetches public.
  await byTestId(page, SEL.distributeRefreshPusdc).click()
  await expect(byTestId(page, SEL.distributeRevealConfidential)).toBeVisible({ timeout: 30_000 })
})
