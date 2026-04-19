import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import type { Address } from 'viem'
import {
  isWhitelisted,
  isAccredited,
  investorCount,
  isAuthorizedOnYieldDistributor,
  isAuthorizedOnEscrow,
  usdcBalance,
  testTreasuryBalance,
} from './chain.js'

const ONE_USDC = 1_000_000n
const ONE_TOKEN = 1_000_000_000_000_000_000n

type Missing = string[]

function renderMissing(role: string, addr: Address, missing: Missing): string {
  const bullets = missing.map((m) => `  · ${m}`).join('\n')
  return [
    '',
    '════════════════════════════════════════════════════════════════════',
    `  ⚠️  Preflight incomplete for ${addr} (${role} role).`,
    '',
    '  Missing:',
    bullets,
    '',
    '  Run this in another terminal:',
    `    E2E_ADDRESS=${addr} pnpm setup:e2e`,
    '',
    '════════════════════════════════════════════════════════════════════',
  ].join('\n')
}

async function checkInvestor(addr: Address): Promise<Missing> {
  const missing: Missing = []
  const [wl, kyc, usdc, tt] = await Promise.all([
    isWhitelisted(addr),
    isAccredited(addr),
    usdcBalance(addr),
    testTreasuryBalance(addr),
  ])
  if (!wl) missing.push('not whitelisted on ERC3643KYCAdapter')
  if (!kyc) missing.push('not accredited on ERC3643KYCAdapter')
  if (usdc < ONE_USDC) missing.push(`USDC balance < 1 USDC (have ${usdc})`)
  if (tt < ONE_TOKEN) missing.push(`TestTreasury balance < 1 token (have ${tt})`)
  return missing
}

async function checkIssuer(addr: Address): Promise<Missing> {
  const missing: Missing = []
  // PUSDC balance is intentionally NOT checked — the public balanceOf is a
  // pseudo-random indicator, not the real balance. DistributePage runs its
  // own true balance check and surfaces a clear error on insufficient.
  const [wl, kyc, ydAuth, escrowAuth, count] = await Promise.all([
    isWhitelisted(addr),
    isAccredited(addr),
    isAuthorizedOnYieldDistributor(addr),
    isAuthorizedOnEscrow(addr),
    investorCount(),
  ])
  if (!wl) missing.push('not whitelisted on ERC3643KYCAdapter')
  if (!kyc) missing.push('not accredited on ERC3643KYCAdapter')
  if (!ydAuth) missing.push('not authorized caller on YieldDistributor')
  if (!escrowAuth) missing.push('not authorized caller on MuHavenEscrow')
  if (count === 0n)
    missing.push('InvestorRegistry.investorCount() == 0 (no registered investors)')
  return missing
}

/**
 * Re-checks on-chain state up to `maxRetries` times. Pauses for the user to
 * run `setup-e2e` between retries when running interactively. In non-TTY
 * environments (CI, Playwright worker without stdio) it fails fast with an
 * actionable message rather than hanging on readline forever.
 */
async function preflight(
  role: 'investor' | 'issuer',
  addr: Address,
  maxRetries = 5,
): Promise<void> {
  const check = role === 'investor' ? checkInvestor : checkIssuer

  // First pass — if already complete, skip all the ceremony.
  const initial = await check(addr)
  if (initial.length === 0) return

  // If we can't prompt (non-TTY), there's no point in looping.
  if (!stdin.isTTY || !stdout.isTTY) {
    console.log(renderMissing(role, addr, initial))
    throw new Error(
      `Preflight for ${role} ${addr} incomplete. Stdin is not a TTY — run setup-e2e yourself and re-run tests.`,
    )
  }

  console.log(renderMissing(role, addr, initial))

  for (let i = 0; i < maxRetries; i++) {
    const rl = createInterface({ input: stdin, output: stdout })
    await rl.question('\n  Press Enter to re-check and continue... ')
    rl.close()

    const missing = await check(addr)
    if (missing.length === 0) return
    console.log(renderMissing(role, addr, missing))
  }

  throw new Error(
    `Preflight for ${role} ${addr} still incomplete after ${maxRetries} retries — giving up.`,
  )
}

export function preflightInvestor(addr: Address): Promise<void> {
  return preflight('investor', addr)
}

export function preflightIssuer(addr: Address): Promise<void> {
  return preflight('issuer', addr)
}
