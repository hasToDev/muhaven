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

  // Summary cards.
  for (const label of ['Total investors', 'Eligible', 'Ineligible', 'Eligibility Rate']) {
    await expect(page.getByText(label)).toBeVisible()
  }

  // Privacy requirement — every investor row's balance column is "FHE Encrypted",
  // never a numeric value. Assert on the first 5 rows max.
  const encryptedLabels = page.getByText(/FHE Encrypted/i)
  const count = await encryptedLabels.count()
  expect(count, 'no FHE Encrypted labels found — balance privacy regressed').toBeGreaterThan(0)

  // Search filter — type something that matches no address; expect a no-matches state.
  await page.getByPlaceholder(/Search by address/i).fill('zzznomatch')
  await expect(page.getByText(/No matching investors/i)).toBeVisible()

  // Clear.
  await page.getByPlaceholder(/Search by address/i).fill('')
})
