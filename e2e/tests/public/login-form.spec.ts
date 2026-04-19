import { test, expect } from '@playwright/test'
import { byTestId, SEL } from '../../lib/selectors.js'

test.describe('login form (no passkey)', () => {
  test('role toggle flips the highlight between investor/issuer', async ({ page }) => {
    await page.goto('/login')

    const investor = byTestId(page, SEL.authRoleInvestor)
    const issuer = byTestId(page, SEL.authRoleIssuer)

    await expect(investor).toBeVisible()
    await expect(issuer).toBeVisible()

    // Investor is selected by default — click issuer and assert the selected
    // class swaps. The selected state renders with text-compute color class.
    await issuer.click()
    const issuerClasses = (await issuer.getAttribute('class')) ?? ''
    expect(issuerClasses).toContain('text-compute')

    const investorClasses = (await investor.getAttribute('class')) ?? ''
    expect(investorClasses).not.toContain('text-compute')

    // Flip back.
    await investor.click()
    const investorClassesAfter = (await investor.getAttribute('class')) ?? ''
    expect(investorClassesAfter).toContain('text-compute')
  })

  test('mode toggle swaps form between Sign In and Create Account', async ({ page }) => {
    await page.goto('/login')

    // Default mode is login — CTA says "Sign In", no passkey name input visible.
    await expect(byTestId(page, SEL.authCta)).toContainText(/Sign In/i)
    await expect(byTestId(page, SEL.authPasskeyNameInput)).not.toBeVisible()

    await byTestId(page, SEL.authModeToggle).click()

    // Register mode — CTA says "Create Account", passkey name input appears.
    await expect(byTestId(page, SEL.authCta)).toContainText(/Create Account/i)
    await expect(byTestId(page, SEL.authPasskeyNameInput)).toBeVisible()

    await byTestId(page, SEL.authModeToggle).click()

    await expect(byTestId(page, SEL.authCta)).toContainText(/Sign In/i)
  })

  test('register with empty passkey name → inline error, no biometric', async ({ page }) => {
    await page.goto('/login')
    await byTestId(page, SEL.authModeToggle).click()

    // Collect any WebAuthn prompt we might accidentally trigger.
    let webauthnAttempted = false
    await page.exposeFunction('__e2eTrackWebauthn', () => {
      webauthnAttempted = true
    })
    await page.evaluate(() => {
      const orig = navigator.credentials.create.bind(navigator.credentials)
      navigator.credentials.create = async (...args) => {
        // @ts-expect-error — injected
        await window.__e2eTrackWebauthn()
        return orig(...args)
      }
    })

    // Click Create Account with empty name.
    await byTestId(page, SEL.authCta).click()

    // Expected inline error text.
    await expect(page.getByText(/Enter a name for your passkey/i)).toBeVisible({
      timeout: 5_000,
    })

    // Give Chromium a beat to surface a prompt if one fired.
    await page.waitForTimeout(500)
    expect(webauthnAttempted, 'Empty-name guard failed to short-circuit the WebAuthn call').toBe(false)
  })
})
