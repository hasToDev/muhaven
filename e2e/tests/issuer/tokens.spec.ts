import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'

test.describe.configure({ mode: 'serial' })

test('issuer tokens page renders aggregate stats + token cards', async ({
  issuerPage: page,
}) => {
  test.setTimeout(0)

  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }

  await page.goto('/tokens')

  // Aggregate summary cards.
  for (const label of ['Total AUM', 'Total Investors', 'Weighted APY', 'Active Tokens']) {
    await expect(page.getByText(label)).toBeVisible()
  }

  // Either at least one token card OR the empty state. The "FHE Encrypted"
  // badge renders via MBadge → <span>, NOT <p> (the prior `p:has-text`
  // locator never matched — that's why the wait always timed out). 60s
  // budget absorbs tokens API fetch + on-chain reads on cold Arb Sepolia.
  const tokenCard = page.getByText(/FHE Encrypted/i).first()
  const emptyState = page.getByText(/No tokens issued yet/i)

  await Promise.race([
    tokenCard.waitFor({ state: 'visible', timeout: 60_000 }),
    emptyState.waitFor({ state: 'visible', timeout: 60_000 }),
  ])

  // Privacy banner always renders at the bottom.
  await expect(
    page.getByText(/Aggregate data only. Individual investor balances are encrypted/i),
  ).toBeVisible()
})
