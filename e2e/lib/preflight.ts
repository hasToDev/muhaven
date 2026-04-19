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
 * Re-checks on-chain state until setup-e2e brings it into compliance.
 *
 * TTY mode (direct `tsx` / `ts-node` invocation): pauses with readline between
 * re-checks — the operator runs setup-e2e in another terminal and presses Enter.
 *
 * Non-TTY mode (Playwright worker — `process.stdin.isTTY === false` because
 * Playwright spawns workers via IPC-piped child processes): prints the
 * "Missing …" block once, then polls every `pollIntervalMs` until either the
 * checks pass or `pollTimeoutMs` elapses. The operator runs setup-e2e during
 * the poll window; the next sweep picks up the new on-chain state and resumes
 * the test. This is the only way a single `playwright test` invocation can
 * bridge the fresh-register → setup-e2e → finish handoff without re-registering.
 */
async function preflight(
  role: 'investor' | 'issuer',
  addr: Address,
  maxRetries = 5,
  pollIntervalMs = 10_000,
  pollTimeoutMs = 5 * 60_000,
): Promise<void> {
  const check = role === 'investor' ? checkInvestor : checkIssuer

  // First pass — if already complete, skip all the ceremony.
  const initial = await check(addr)
  if (initial.length === 0) return

  // Non-TTY (Playwright worker) — poll, don't prompt.
  if (!stdin.isTTY || !stdout.isTTY) {
    console.log(renderMissing(role, addr, initial))
    console.log(
      `\n  (stdin not a TTY — polling every ${pollIntervalMs / 1000}s for up to ${pollTimeoutMs / 60_000} min.\n   Run setup-e2e now; the test will resume automatically.)\n`,
    )
    const deadline = Date.now() + pollTimeoutMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs))
      const missing = await check(addr)
      if (missing.length === 0) {
        console.log(`  ✓ Preflight satisfied for ${addr} — resuming.`)
        return
      }
    }
    throw new Error(
      `Preflight for ${role} ${addr} still incomplete after ${pollTimeoutMs / 60_000} min of polling — giving up.`,
    )
  }

  // TTY (direct invocation) — pause on readline between re-checks.
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
