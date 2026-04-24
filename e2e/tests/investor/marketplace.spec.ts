import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'
import { byTestId, SEL } from '../../lib/selectors.js'

test.describe.configure({ mode: 'serial' })

test('marketplace — search + filter + Invest navigates with ?token= param', async ({
  investorPage: page,
}) => {
  test.setTimeout(0)

  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }

  await page.goto('/marketplace')

  const cards = page.getByTestId(SEL.marketplaceTokenCard)
  await expect(cards.first()).toBeVisible({ timeout: 15_000 })
  const initialCount = await cards.count()
  expect(initialCount).toBeGreaterThan(0)

  // Grab the first token's symbol via its stable testid.
  const firstSymbol = (
    await cards.first().getByTestId(SEL.marketplaceTokenSymbol).innerText()
  ).trim()
  expect(firstSymbol.length, 'empty token symbol — MarketplacePage card broken').toBeGreaterThan(0)

  // Filter by search — at minimum, shouldn't drop to 0 for its own symbol.
  await byTestId(page, SEL.marketplaceSearch).fill(firstSymbol)
  await expect(cards.first()).toBeVisible()
  const afterSearchCount = await cards.count()
  expect(afterSearchCount).toBeGreaterThan(0)

  // Clear + click Invest on the first card → /trade?token=<address>.
  // Wave 3.5 Phase 6.5 renamed the buy page to /trade (with /buy + /deposit
  // kept as redirect aliases).
  await byTestId(page, SEL.marketplaceSearch).fill('')

  const firstCard = cards.first()
  const tokenAddress = await firstCard.getAttribute('data-token-address')
  expect(tokenAddress).toMatch(/^0x[a-fA-F0-9]{40}$/)

  await firstCard.getByTestId(SEL.marketplaceInvestCta).click({ force: true })

  await page.waitForURL(/\/trade/)
  const url = new URL(page.url())
  expect(url.searchParams.get('token')?.toLowerCase()).toBe(tokenAddress!.toLowerCase())
})
