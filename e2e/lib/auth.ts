import type { Page } from '@playwright/test'
import type { Address } from 'viem'
import { SEL, byTestId } from './selectors.js'

const WAIT_BIOMETRIC = 180_000
const WAIT_WHITELIST = 120_000

/**
 * Expand a truncated `0x12b5...f09A` display address by reading the pill's
 * `data-full-address` attribute — always reflects the reactive wallet
 * address regardless of `copied` state (unlike `title` / `aria-label` which
 * swap to "Copied!" for 1.5s after a click).
 */
async function fullAddressFromPill(page: Page): Promise<Address> {
  const pill = byTestId(page, SEL.navWalletPill)
  await pill.waitFor({ state: 'visible', timeout: 30_000 })
  const attr = await pill.getAttribute('data-full-address')
  if (attr && /^0x[a-fA-F0-9]{40}$/.test(attr)) return attr as Address

  // Fallback — read the title/aria-label (works outside the 1.5s post-copy window).
  const title = await pill.getAttribute('title')
  const fromTitle = title?.match(/0x[a-fA-F0-9]{40}/)?.[0]
  if (fromTitle) return fromTitle as Address
  const aria = await pill.getAttribute('aria-label')
  const fromAria = aria?.match(/0x[a-fA-F0-9]{40}/)?.[0]
  if (!fromAria) {
    throw new Error('Could not extract full smart account address from TopNav wallet pill')
  }
  return fromAria as Address
}

export async function getSmartAddress(page: Page): Promise<Address> {
  return fullAddressFromPill(page)
}

export async function isAuthenticated(page: Page): Promise<boolean> {
  // 15s window — LandingPage mounts TopNav async, so the prior 4s budget
  // false-negative on slow RPC/CoFHE loads and then triggered a spurious
  // login() call that hung waiting for a login form that never rendered.
  try {
    await byTestId(page, SEL.navWalletPill).waitFor({ state: 'visible', timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

export async function logout(page: Page): Promise<void> {
  // No-op if already logged out — the logout button only exists behind auth.
  if (!(await isAuthenticated(page))) return
  const logoutBtn = byTestId(page, SEL.navWalletLogout)
  await logoutBtn.click({ force: true })
  await page.waitForURL(/\/login/, { timeout: 300_000 })
}

/**
 * Walks the LoginPage register flow: toggles mode, picks role, fills name,
 * clicks Create Account, waits for the user to confirm biometrics, then
 * clicks Enable demo access. Returns the new smart account address.
 *
 * Pauses silently for the human to confirm passkey prompts — relies on the
 * post-biometric DOM state to resume (no readline).
 */
export async function register(
  page: Page,
  role: 'investor' | 'issuer',
  passkeyName: string,
): Promise<Address> {
  await page.goto('/login')

  // Toggle to register mode if we're on the login form.
  const modeToggle = byTestId(page, SEL.authModeToggle)
  await modeToggle.waitFor({ state: 'visible', timeout: 300_000 })
  const toggleText = (await modeToggle.textContent()) ?? ''
  if (/New here/i.test(toggleText)) {
    await modeToggle.click()
  }

  // Pick role.
  const roleTestid = role === 'investor' ? SEL.authRoleInvestor : SEL.authRoleIssuer
  await byTestId(page, roleTestid).click({ force: true })

  // Passkey name.
  await byTestId(page, SEL.authPasskeyNameInput).fill(passkeyName)

  // Create Account — triggers the first biometric prompt.
  await byTestId(page, SEL.authCta).click({ force: true })

  // Wait for the demo banner to appear (proves SIWE + backend verify succeeded).
  await byTestId(page, SEL.authDemoWhitelistCta).waitFor({
    state: 'visible',
    timeout: WAIT_BIOMETRIC,
  })

  // Click whitelist — triggers the backend-signed tx, then redirects.
  await byTestId(page, SEL.authDemoWhitelistCta).click({ force: true })

  // Wait for redirect to dashboard. Investor → /portfolio, Issuer → /tokens.
  await page.waitForURL(/\/(portfolio|tokens|marketplace)/, { timeout: WAIT_WHITELIST })

  return fullAddressFromPill(page)
}

/**
 * Walks the LoginPage login flow. Pauses for biometric.
 *
 * Resilient to already-authenticated state: if `/login` redirects to a
 * dashboard route (investor-or-issuer route guard fires when a valid session
 * exists), short-circuits and returns the current smart address without
 * waiting for the login form. This prevents the hang mode we hit in the
 * first end-to-end run where a warm profile re-entering `login()` sat at a
 * `/login → /portfolio` redirect waiting for `auth-mode-toggle` forever.
 */
export async function login(page: Page): Promise<Address> {
  await page.goto('/login')

  // Already authenticated? `/login` redirects to a dashboard — return the pill.
  try {
    await page.waitForURL(/\/(portfolio|tokens|marketplace)/, { timeout: 3_000 })
    return fullAddressFromPill(page)
  } catch {
    // Not authenticated — proceed with the login form.
  }

  // If we're in register mode, flip to login.
  const modeToggle = byTestId(page, SEL.authModeToggle)
  await modeToggle.waitFor({ state: 'visible', timeout: 300_000 })
  const toggleText = (await modeToggle.textContent()) ?? ''
  if (/Already have/i.test(toggleText)) {
    await modeToggle.click()
  }

  await byTestId(page, SEL.authCta).click({ force: true })

  // Wait for dashboard redirect.
  await page.waitForURL(/\/(portfolio|tokens|marketplace)/, { timeout: WAIT_BIOMETRIC })

  return fullAddressFromPill(page)
}

/**
 * Uses the "Skip for now" link on the post-register awaiting-whitelist screen,
 * bypassing the demo whitelist. Returns the address regardless.
 */
export async function registerSkipWhitelist(
  page: Page,
  role: 'investor' | 'issuer',
  passkeyName: string,
): Promise<Address> {
  await page.goto('/login')

  const modeToggle = byTestId(page, SEL.authModeToggle)
  await modeToggle.waitFor({ state: 'visible', timeout: 300_000 })
  const toggleText = (await modeToggle.textContent()) ?? ''
  if (/New here/i.test(toggleText)) {
    await modeToggle.click()
  }

  const roleTestid = role === 'investor' ? SEL.authRoleInvestor : SEL.authRoleIssuer
  await byTestId(page, roleTestid).click({ force: true })
  await byTestId(page, SEL.authPasskeyNameInput).fill(passkeyName)
  await byTestId(page, SEL.authCta).click({ force: true })

  await byTestId(page, SEL.authDemoSkip).waitFor({
    state: 'visible',
    timeout: WAIT_BIOMETRIC,
  })
  await byTestId(page, SEL.authDemoSkip).click()

  await page.waitForURL(/\/(portfolio|tokens|marketplace)/, { timeout: 300_000 })
  return fullAddressFromPill(page)
}
