import type { Address, Hash, PublicClient, WalletClient } from 'viem'
import type { CofheLikeClient, EncryptedInput, ProgressCallback } from './types.js'
import {
  BatchSizeExceededError,
  ConfigError,
  DistributionAlreadyCompleteError,
  DistributionNotStartedError,
  EscrowIdsAlreadySetError,
} from './errors.js'
import { yieldDistributorAbi } from './abi/yieldDistributor.js'
import { writeAndWait } from './internal/contract.js'
import { encryptUint64 } from './internal/encryption.js'
import { MAX_BATCH_SIZE } from './constants.js'
import { InvariantError } from './errors.js'

/**
 * Distribution status enum as encoded in YieldDistributor.getDistribution.
 * Matches the Solidity enum `{ PENDING, IN_PROGRESS, COMPLETED }`.
 *
 * Lifecycle:
 *   PENDING      — startDistribution called, no processBatch yet
 *   IN_PROGRESS  — at least one processBatch call has funded escrows
 *   COMPLETED    — all investors processed; subsequent processBatch reverts
 */
export const DistributionStatus = {
  Pending: 0,
  InProgress: 1,
  Complete: 2,
} as const

type DistributionTuple = readonly [
  token: Address,
  encTotalYield: `0x${string}`,
  encPerInvestorYield: `0x${string}`,
  investorCount: bigint,
  processedCount: bigint,
  escrowsCreated: bigint,
  status: number,
]

/**
 * Read a distribution's current state from YieldDistributor.
 */
export async function getDistribution(
  publicClient: PublicClient,
  yieldDistributor: Address,
  distributionId: bigint,
): Promise<{
  token: Address
  investorCount: bigint
  processedCount: bigint
  escrowsCreated: bigint
  status: number
}> {
  const raw = await publicClient.readContract({
    address: yieldDistributor,
    abi: yieldDistributorAbi,
    functionName: 'getDistribution',
    args: [distributionId],
  }) as DistributionTuple

  return {
    token: raw[0],
    investorCount: raw[3],
    processedCount: raw[4],
    escrowsCreated: raw[5],
    status: raw[6],
  }
}

/**
 * Start a new distribution by submitting the issuer's encrypted total yield.
 * Returns the new distributionId parsed from DistributionStarted logs.
 */
export async function startDistributionFlow(args: {
  publicClient: PublicClient
  walletClient: WalletClient
  cofheClient: CofheLikeClient
  yieldDistributor: Address
  totalYield: bigint
  onProgress?: ProgressCallback
}): Promise<{ distributionId: bigint; txHash: Hash }> {
  const { publicClient, walletClient, cofheClient, yieldDistributor, totalYield, onProgress } = args
  if (totalYield <= 0n) throw new ConfigError(`totalYield must be > 0, got ${totalYield}`)

  onProgress?.({
    stage: 'encrypt',
    current: 0,
    total: 1,
    message: 'Encrypting total yield amount',
  })

  const enc: EncryptedInput = await encryptUint64(cofheClient, totalYield)

  const { hash, logs } = await writeAndWait({
    publicClient,
    walletClient,
    address: yieldDistributor,
    abi: yieldDistributorAbi,
    functionName: 'startDistribution',
    args: [{
      ctHash: enc.ctHash,
      securityZone: enc.securityZone,
      utype: enc.utype,
      signature: enc.signature,
    }],
    operation: 'YieldDistributor.startDistribution',
  })

  // Parse DistributionStarted event to get the new distributionId.
  const { parseEventLogs } = await import('viem')
  const events = parseEventLogs({
    abi: yieldDistributorAbi as any,
    eventName: 'DistributionStarted',
    logs,
  })

  const match = events.find(
    log => log.address.toLowerCase() === yieldDistributor.toLowerCase(),
  )
  if (!match) {
    throw new InvariantError('YieldDistributor.startDistribution emitted no DistributionStarted event')
  }
  const distributionId = (match as unknown as { args: { distributionId: bigint } }).args.distributionId

  onProgress?.({
    stage: 'startDistribution',
    current: 1,
    total: 1,
    message: `Distribution ${distributionId} started`,
    txHash: hash,
  })

  return { distributionId, txHash: hash }
}

/**
 * Attach the pre-created escrowIds to an in-progress distribution.
 * One-shot: subsequent calls revert with EscrowIdsAlreadySet. Also enforces
 * length match against the distribution's investorCount.
 */
export async function setEscrowIdsFlow(args: {
  publicClient: PublicClient
  walletClient: WalletClient
  yieldDistributor: Address
  distributionId: bigint
  escrowIds: bigint[]
  onProgress?: ProgressCallback
}): Promise<Hash> {
  const { publicClient, walletClient, yieldDistributor, distributionId, escrowIds, onProgress } = args

  const { hash } = await writeAndWait({
    publicClient,
    walletClient,
    address: yieldDistributor,
    abi: yieldDistributorAbi,
    functionName: 'setEscrowIds',
    args: [distributionId, escrowIds],
    operation: 'YieldDistributor.setEscrowIds',
  })

  onProgress?.({
    stage: 'setEscrowIds',
    current: 1,
    total: 1,
    message: `Attached ${escrowIds.length} escrowIds to distribution ${distributionId}`,
    txHash: hash,
  })

  return hash
}

/**
 * Drive processBatch → fundFrom until the distribution completes.
 * Reports progress per batch via the optional callback.
 */
export async function processUntilCompleteFlow(args: {
  publicClient: PublicClient
  walletClient: WalletClient
  yieldDistributor: Address
  distributionId: bigint
  batchSize: number
  onProgress?: ProgressCallback
}): Promise<{ batchesProcessed: number; txHashes: Hash[] }> {
  const { publicClient, walletClient, yieldDistributor, distributionId, batchSize, onProgress } = args

  if (batchSize <= 0 || batchSize > MAX_BATCH_SIZE) {
    throw new BatchSizeExceededError(batchSize, MAX_BATCH_SIZE)
  }

  // Detect non-existent distributions via distributionCount; the contract's
  // mapping returns a zeroed struct for unknown IDs (status = PENDING(0)),
  // so status alone can't distinguish "just started" from "never started".
  const count = await publicClient.readContract({
    address: yieldDistributor,
    abi: yieldDistributorAbi,
    functionName: 'distributionCount',
  }) as bigint
  if (distributionId === 0n || distributionId > count) {
    throw new DistributionNotStartedError(distributionId)
  }

  const initial = await getDistribution(publicClient, yieldDistributor, distributionId)
  if (initial.status === DistributionStatus.Complete) {
    throw new DistributionAlreadyCompleteError(distributionId)
  }

  const total = Number(initial.investorCount)
  const txHashes: Hash[] = []
  let batchesProcessed = 0

  while (true) {
    const state = await publicClient.readContract({
      address: yieldDistributor,
      abi: yieldDistributorAbi,
      functionName: 'isDistributionComplete',
      args: [distributionId],
    }) as boolean
    if (state) break

    const { hash } = await writeAndWait({
      publicClient,
      walletClient,
      address: yieldDistributor,
      abi: yieldDistributorAbi,
      functionName: 'processBatch',
      args: [distributionId, BigInt(batchSize)],
      operation: 'YieldDistributor.processBatch',
    })
    txHashes.push(hash)
    batchesProcessed += 1

    const updated = await getDistribution(publicClient, yieldDistributor, distributionId)
    onProgress?.({
      stage: 'processBatch',
      current: Number(updated.processedCount),
      total,
      message: `Processed ${updated.processedCount}/${total} investors`,
      txHash: hash,
    })
  }

  return { batchesProcessed, txHashes }
}

/**
 * High-level: setEscrowIds + processBatch loop.
 * Used by `MuHavenClient.fundEscrows`.
 */
export async function fundEscrowsFlow(args: {
  publicClient: PublicClient
  walletClient: WalletClient
  yieldDistributor: Address
  distributionId: bigint
  escrowIds: bigint[]
  batchSize: number
  onProgress?: ProgressCallback
}): Promise<{ batchesProcessed: number; txHashes: Hash[] }> {
  const { publicClient, walletClient, yieldDistributor, distributionId, escrowIds, batchSize, onProgress } = args

  if (escrowIds.length === 0) throw new ConfigError('escrowIds is empty')

  const count = await publicClient.readContract({
    address: yieldDistributor,
    abi: yieldDistributorAbi,
    functionName: 'distributionCount',
  }) as bigint
  if (distributionId === 0n || distributionId > count) {
    throw new DistributionNotStartedError(distributionId)
  }

  const before = await getDistribution(publicClient, yieldDistributor, distributionId)
  if (before.status === DistributionStatus.Complete) {
    throw new DistributionAlreadyCompleteError(distributionId)
  }
  if (before.investorCount !== BigInt(escrowIds.length)) {
    throw new ConfigError(
      `escrowIds length ${escrowIds.length} != investorCount ${before.investorCount}`,
    )
  }

  // Resume-aware "already attached" check:
  //   - no IDs attached → set them now, then drive processBatch
  //   - same IDs attached → prior setEscrowIds landed but processBatch didn't
  //     finish; skip the set and resume the processBatch loop
  //   - different IDs attached → another caller attached a conflicting set;
  //     surface as EscrowIdsAlreadySetError
  const existing = await publicClient.readContract({
    address: yieldDistributor,
    abi: yieldDistributorAbi,
    functionName: 'getEscrowIds',
    args: [distributionId],
  }) as readonly bigint[]

  const txHashesBeforeProcess: Hash[] = []

  if (existing.length === 0) {
    const setTx = await setEscrowIdsFlow({
      publicClient, walletClient, yieldDistributor,
      distributionId, escrowIds, onProgress,
    })
    txHashesBeforeProcess.push(setTx)
  } else {
    const matches =
      existing.length === escrowIds.length &&
      existing.every((id, i) => id === escrowIds[i])
    if (!matches) {
      throw new EscrowIdsAlreadySetError(distributionId)
    }
    onProgress?.({
      stage: 'setEscrowIds',
      current: 1,
      total: 1,
      message: `Resuming distribution ${distributionId}: ${existing.length} escrowIds already attached`,
    })
  }

  const { batchesProcessed, txHashes } = await processUntilCompleteFlow({
    publicClient, walletClient, yieldDistributor,
    distributionId, batchSize, onProgress,
  })

  return {
    batchesProcessed,
    txHashes: [...txHashesBeforeProcess, ...txHashes],
  }
}
