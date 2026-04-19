/**
 * Lightweight preflight assertions designed to run in spec `beforeAll` hooks.
 * These differ from `lib/preflight.ts` in that they do NOT pause for user
 * input — they skip the spec with an actionable message if state is missing.
 *
 * Intended for specs that assume the profile was already set up by the auth
 * suite. If the user runs a single spec standalone without having bootstrapped,
 * the spec skips cleanly instead of producing silent-failure deposits or
 * confusing contract reverts mid-run.
 */
import type { TestInfo } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { Address } from 'viem'
import { getSmartAddress, isAuthenticated, login } from './auth.js'
import {
  isWhitelisted,
  isAccredited,
  isAuthorizedOnYieldDistributor,
  isAuthorizedOnEscrow,
} from './chain.js'

async function getOrLoginAddress(page: Page): Promise<Address> {
  await page.goto('/')
  if (!(await isAuthenticated(page))) {
    return login(page)
  }
  return getSmartAddress(page)
}

/**
 * Skips the current test if the investor profile isn't set up. Call from
 * `test.beforeAll` in any investor-flow spec that requires a whitelisted,
 * KYC'd wallet (deposits, claims, etc.).
 */
export async function ensureInvestorReady(page: Page, testInfo: TestInfo): Promise<Address> {
  const addr = await getOrLoginAddress(page)
  const [wl, kyc] = await Promise.all([isWhitelisted(addr), isAccredited(addr)])
  if (!wl || !kyc) {
    testInfo.skip(
      true,
      `Investor ${addr} not whitelisted/accredited yet. Run auth/register-investor.spec.ts + setup-e2e first.`,
    )
  }
  return addr
}

/**
 * Skips the current test if the issuer profile isn't set up. Call from
 * `test.beforeAll` in any issuer-flow spec that requires authorized-caller
 * status.
 */
export async function ensureIssuerReady(page: Page, testInfo: TestInfo): Promise<Address> {
  const addr = await getOrLoginAddress(page)
  const [wl, kyc, ydAuth, escrowAuth] = await Promise.all([
    isWhitelisted(addr),
    isAccredited(addr),
    isAuthorizedOnYieldDistributor(addr),
    isAuthorizedOnEscrow(addr),
  ])
  const missing: string[] = []
  if (!wl) missing.push('not whitelisted')
  if (!kyc) missing.push('not accredited')
  if (!ydAuth) missing.push('not authorized on YieldDistributor')
  if (!escrowAuth) missing.push('not authorized on MuHavenEscrow')
  if (missing.length > 0) {
    testInfo.skip(
      true,
      `Issuer ${addr} setup incomplete: ${missing.join(', ')}. Run auth/register-issuer.spec.ts + setup-e2e first.`,
    )
  }
  return addr
}
