import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'
import { byTestId, SEL } from '../../lib/selectors.js'

test.describe.configure({ mode: 'serial' })

test('PUSDC card — decrypt confidential portion + refresh', async ({ investorPage: page }) => {
  test.setTimeout(0)

  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }

  await page.goto('/portfolio')

  const decryptBtn = byTestId(page, SEL.portfolioPusdcDecryptCta)
  const cardVisible = await decryptBtn
    .isVisible({ timeout: 5_000 })
    .catch(() => false)
  test.skip(!cardVisible, 'PUSDC card not rendered — account has no PUSDC balance')

  await decryptBtn.click({ force: true })

  // After decrypt, the button is replaced with a Refresh control + a cipher-colored amount.
  await expect(byTestId(page, SEL.portfolioPusdcRefresh)).toBeVisible({ timeout: 120_000 })

  // Click Refresh — re-reads + re-decrypts. No prompt expected (FHE already permitted).
  await byTestId(page, SEL.portfolioPusdcRefresh).click()

  // Still visible after refresh.
  await expect(byTestId(page, SEL.portfolioPusdcRefresh)).toBeVisible({ timeout: 30_000 })
})
