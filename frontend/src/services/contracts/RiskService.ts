/**
 * Service for RiskParams contract interactions.
 * Encrypted investor risk guardrails (max drawdown, min yield, drift tolerance, max daily spend).
 *
 * Reads: publicClient.readContract()
 * Writes: sendUserOperation() (gasless)
 */

import { addresses } from '@/contracts/addresses'
import { riskParamsAbi } from '@/contracts/abis'
import { contractRead, contractWrite, pollUntil } from './provider'
import type { EncryptedInput, RiskParamsDecryptResult, TxHash } from './types'

const CONTRACT = 'RiskParams'
const addr = addresses.riskParams

// ── Reads ──────────────────────────────────────────────────────────

export async function hasRiskParams(investor: `0x${string}`): Promise<boolean> {
  return contractRead(addr, riskParamsAbi, 'hasRiskParams', [investor], CONTRACT) as Promise<boolean>
}

export async function getRiskParamsDecryptResult(
  investor: `0x${string}`,
): Promise<RiskParamsDecryptResult> {
  const [maxDrawdownBps, minYieldBps, driftToleranceBps, maxDailySpend, d0, d1, d2, d3] =
    await contractRead(
      addr, riskParamsAbi, 'getRiskParamsDecryptResult', [investor], CONTRACT,
    ) as [bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean]

  return {
    maxDrawdownBps,
    minYieldBps,
    driftToleranceBps,
    maxDailySpend,
    allDecrypted: d0 && d1 && d2 && d3,
  }
}

// ── Writes ─────────────────────────────────────────────────────────

export async function setRiskParams(
  encMaxDrawdownBps: EncryptedInput,
  encMinYieldBps: EncryptedInput,
  encDriftToleranceBps: EncryptedInput,
  encMaxDailySpend: EncryptedInput,
): Promise<TxHash> {
  return contractWrite(
    addr,
    riskParamsAbi,
    'setRiskParams',
    [encMaxDrawdownBps, encMinYieldBps, encDriftToleranceBps, encMaxDailySpend],
    CONTRACT,
  )
}

export async function requestRiskParamsDecrypt(investor: `0x${string}`): Promise<TxHash> {
  return contractWrite(
    addr, riskParamsAbi, 'requestRiskParamsDecrypt', [investor], CONTRACT,
  )
}

// ── Convenience: full decrypt flow ─────────────────────────────────

/**
 * Request + poll for decrypted risk params.
 * Sends the decrypt request tx, then polls until all four params are decrypted.
 */
export async function decryptRiskParams(
  investor: `0x${string}`,
  { intervalMs = 3000, maxAttempts = 20 } = {},
): Promise<RiskParamsDecryptResult> {
  await requestRiskParamsDecrypt(investor)

  return pollUntil(
    () => getRiskParamsDecryptResult(investor),
    r => r.allDecrypted,
    { intervalMs, maxAttempts, label: `risk params decrypt for ${investor}` },
  )
}
