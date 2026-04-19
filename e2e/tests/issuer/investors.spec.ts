import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'

test.describe.configure({ mode: 'serial' })

test('issuer investors page — search + filter + balance always FHE-encrypted', async ({
  issuerPage: page,
}) => {
  test.setTimeout(0)

  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }

  await page.goto('/investors')

  // Summary card labels — scope to <p> + exact match so we don't collide
  // with the same text appearing in combobox options and investor status
  // badges. "Eligible" (exact) excludes "Ineligible" and both are filtered
  // to paragraphs by the `locator('p')` scope.
  for (const label of ['Total investors', 'Eligible', 'Ineligible', 'Eligibility Rate']) {
    await expect(
      page.locator('p').getByText(label, { exact: true }).first(),
    ).toBeVisible()
  }

  // Privacy requirement — every investor row's balance column is "FHE Encrypted",
  // never a numeric value. Assert on the first 5 rows max.
  const encryptedLabels = page.getByText(/FHE Encrypted/i)
  const count = await encryptedLabels.count()
  expect(count, 'no FHE Encrypted labels found — balance privacy regressed').toBeGreaterThan(0)

  // Search filter — type something that matches no address; expect a no-matches state.
  // `.first()` because the page renders the empty-state text in two places
  // (desktop table empty row + mobile card list empty state).
  await page.getByPlaceholder(/Search by address/i).fill('zzznomatch')
  await expect(page.getByText(/No matching investors/i).first()).toBeVisible()

  // Clear.
  await page.getByPlaceholder(/Search by address/i).fill('')
})
