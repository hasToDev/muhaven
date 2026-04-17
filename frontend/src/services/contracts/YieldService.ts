/**
 * Service for YieldDistributor contract interactions.
 *
 * Reads: publicClient.readContract()
 * Writes: sendUserOperation() (gasless)
 */

import { addresses } from '@/contracts/addresses'
import { yieldDistributorAbi } from '@/contracts/abis'
import { contractRead, contractWrite } from './provider'
import { DistributionStatus } from './types'
import type { EncryptedInput, Distribution, TxHash } from './types'

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

