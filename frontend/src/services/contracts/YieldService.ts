/**
 * Service for YieldDistributor contract interactions.
 *
 * Reads: publicClient.readContract()
 * Writes: sendUserOperation() (gasless)
 */

import { addresses } from '@/contracts/addresses'
import { yieldDistributorAbi } from '@/contracts/abis'
import { contractRead, contractWrite, pollUntil } from './provider'
import { DistributionStatus } from './types'
import type { EncryptedInput, Distribution, YieldDecryptResult, TxHash } from './types'

const CONTRACT = 'YieldDistributor'
const addr = addresses.yieldDistributor

// ── Reads ──────────────────────────────────────────────────────────

export async function getDistribution(distributionId: bigint): Promise<Distribution> {
  const [token, encTotalYield, encPerInvestorYield, investorCount, processedCount, escrowsCreated, status] =
    await contractRead(
      addr, yieldDistributorAbi, 'getDistribution', [distributionId], CONTRACT,
    ) as [`0x${string}`, `0x${string}`, `0x${string}`, bigint, bigint, bigint, number]

  return {
    token,
    encTotalYield,
    encPerInvestorYield,
    investorCount,
    processedCount,
    escrowsCreated,
    status: status as DistributionStatus,
  }
}

export async function isDistributionComplete(distributionId: bigint): Promise<boolean> {
  return contractRead(
    addr, yieldDistributorAbi, 'isDistributionComplete', [distributionId], CONTRACT,
  ) as Promise<boolean>
}

export async function distributionCount(): Promise<bigint> {
  return contractRead(addr, yieldDistributorAbi, 'distributionCount', [], CONTRACT) as Promise<bigint>
}

export async function getYieldDecryptResult(distributionId: bigint): Promise<YieldDecryptResult> {
  const [totalYield, totalYieldDecrypted, perInvestorYield, perInvestorYieldDecrypted] =
    await contractRead(
      addr, yieldDistributorAbi, 'getYieldDecryptResult', [distributionId], CONTRACT,
    ) as [bigint, boolean, bigint, boolean]

  return { totalYield, totalYieldDecrypted, perInvestorYield, perInvestorYieldDecrypted }
}

// ── Writes ─────────────────────────────────────────────────────────

export async function startDistribution(encrypted: EncryptedInput): Promise<TxHash> {
  return contractWrite(addr, yieldDistributorAbi, 'startDistribution', [encrypted], CONTRACT)
}

export async function startDistributionFromBalance(): Promise<TxHash> {
  return contractWrite(addr, yieldDistributorAbi, 'startDistributionFromBalance', [], CONTRACT)
}

export async function processBatch(distributionId: bigint, batchSize: bigint): Promise<TxHash> {
  return contractWrite(
    addr, yieldDistributorAbi, 'processBatch', [distributionId, batchSize], CONTRACT,
  )
}

export async function requestYieldDecrypt(distributionId: bigint): Promise<TxHash> {
  return contractWrite(
    addr, yieldDistributorAbi, 'requestYieldDecrypt', [distributionId], CONTRACT,
  )
}

// ── Convenience: full decrypt flow ─────────────────────────────────

/**
 * Request + poll for decrypted yield data.
 * Sends the decrypt request tx, then polls until both values are decrypted.
 */
export async function decryptYield(
  distributionId: bigint,
  { intervalMs = 3000, maxAttempts = 20 } = {},
): Promise<YieldDecryptResult> {
  await requestYieldDecrypt(distributionId)

  return pollUntil(
    () => getYieldDecryptResult(distributionId),
    r => r.totalYieldDecrypted && r.perInvestorYieldDecrypted,
    { intervalMs, maxAttempts, label: `yield decrypt for distribution #${distributionId}` },
  )
}
