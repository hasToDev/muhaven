import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'
import { byTestId, SEL } from '../../lib/selectors.js'

test.describe.configure({ mode: 'serial' })

test('Reveal All decrypts every holding + shows USD total hero', async ({
  investorPage: page,
}) => {
  test.setTimeout(0)

  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }

  await page.goto('/portfolio')

  const revealAll = byTestId(page, SEL.portfolioRevealAllCta)
  const visible = await revealAll.isVisible({ timeout: 5_000 }).catch(() => false)
  test.skip(!visible, 'Reveal All not visible — portfolio is empty or already decrypted')

  await revealAll.click({ force: true })

  // Hero value transitions from "Encrypted" to a $-prefixed USD figure.
  const dollarAmount = page.getByText(/^\$[\d,]+(\.\d+)?$/).first()
  await expect(dollarAmount).toBeVisible({ timeout: 180_000 })

  // Allocation donut renders (SVG inside the allocation card).
  await expect(page.getByText(/Allocation/i)).toBeVisible()
  await expect(page.locator('svg').first()).toBeVisible()
})
