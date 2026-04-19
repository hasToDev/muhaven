import { roleTest as test, expect } from '../../lib/fixtures.js'
import { login, isAuthenticated } from '../../lib/auth.js'

test.describe.configure({ mode: 'serial' })

test('compliance page renders KYC config + jurisdictions + trusted issuers (preview)', async ({
  issuerPage: page,
}) => {
  test.setTimeout(0)

  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    await login(page)
  }

  await page.goto('/compliance')

  // Headline.
  await expect(page.getByRole('heading', { name: /Compliance/i })).toBeVisible()

  // KYC Gate Configuration card.
  await expect(page.getByText(/KYC Gate Configuration/i)).toBeVisible()
  await expect(page.getByText(/Provider/i).first()).toBeVisible()
  await expect(page.getByText(/Required Level/i)).toBeVisible()

  // Jurisdiction + Trusted Issuers sections have a "Preview Data" badge.
  const previewBadges = page.getByText(/Preview Data/i)
  expect(await previewBadges.count()).toBeGreaterThanOrEqual(2)

  // The Edit + Add Issuer buttons are placeholders — assert they're disabled.
  const editBtn = page.getByRole('button', { name: /Edit/i }).first()
  if (await editBtn.isVisible().catch(() => false)) {
    await expect(editBtn).toBeDisabled()
  }

  const addIssuerBtn = page.getByRole('button', { name: /\+ Add Issuer/i })
  if (await addIssuerBtn.isVisible().catch(() => false)) {
    await expect(addIssuerBtn).toBeDisabled()
  }
})
