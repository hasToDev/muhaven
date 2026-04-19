import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'
import { byTestId, SEL } from '../../lib/selectors.js'

test.describe.configure({ mode: 'serial' })

test('decrypt a single holding balance on /portfolio', async ({ investorPage: page }) => {
  test.setTimeout(0)

  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }

  await page.goto('/portfolio')

  const firstHolding = byTestId(page, SEL.portfolioHoldingCard).first()
  const hasHolding = await firstHolding
    .isVisible({ timeout: 10_000 })
    .catch(() => false)
  test.skip(
    !hasHolding,
    'no holdings yet — run investor/deposit-encrypted.spec.ts first',
  )

  // Pre-state: encrypted badge visible in the card.
  await expect(firstHolding.getByText(/FHE Encrypted/i)).toBeVisible()

  // Click Decrypt Balance inside the first holding card.
  await firstHolding.getByTestId(SEL.portfolioDecryptCta).click({ force: true })

  // Post-state: "Decrypted" badge appears within 2 min (CoFHE coprocessor round-trip).
  await expect(firstHolding.getByText(/Decrypted/i).first()).toBeVisible({ timeout: 120_000 })
})
