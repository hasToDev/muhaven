import type { Address, Hash, PublicClient, WalletClient } from 'viem'
import type { ProgressCallback } from './types.js'
import { BatchSizeExceededError, ConfigError } from './errors.js'
import { muhavenEscrowAbi } from './abi/muhavenEscrow.js'
import { writeAndWait } from './internal/contract.js'
import { MAX_BATCH_SIZE } from './constants.js'

/**
 * Redeem a single escrow. Returns the transaction hash.
 *
 * Reminder: MuHavenEscrow uses silent-failure FHE checks. Even when the
 * encrypted canRedeem gate denies redemption (wrong caller, already redeemed,
 * resolver denies), the tx succeeds and emits `EscrowRedeemed`. Callers MUST
 * verify the encrypted `isRedeemed` handle or observe PUSDC balance movement
 * before treating the claim as successful. See MuHavenEscrow.redeem NatSpec.
 */
export async function claimYieldFlow(args: {
  publicClient: PublicClient
  walletClient: WalletClient
  muhavenEscrow: Address
  escrowId: bigint
  onProgress?: ProgressCallback
}): Promise<Hash> {
  const { publicClient, walletClient, muhavenEscrow, escrowId, onProgress } = args

  const { hash } = await writeAndWait({
    publicClient,
    walletClient,
    address: muhavenEscrow,
    abi: muhavenEscrowAbi,
    functionName: 'redeem',
    args: [escrowId],
    operation: 'MuHavenEscrow.redeem',
  })

  onProgress?.({
    stage: 'redeem',
    current: 1,
    total: 1,
    message: `Redeemed escrow ${escrowId}`,
    txHash: hash,
  })

  return hash
}

/**
 * Redeem a batch of escrows in a single tx via redeemMultiple.
 * Non-existent escrowIds are silently skipped on-chain (see MuHavenEscrow
 * docs for the intentional asymmetry with `redeem()`).
 */
export async function claimYieldBatchFlow(args: {
  publicClient: PublicClient
  walletClient: WalletClient
  muhavenEscrow: Address
  escrowIds: bigint[]
  onProgress?: ProgressCallback
}): Promise<Hash> {
  const { publicClient, walletClient, muhavenEscrow, escrowIds, onProgress } = args
  if (escrowIds.length === 0) throw new ConfigError('escrowIds is empty')
  if (escrowIds.length > MAX_BATCH_SIZE) {
    throw new BatchSizeExceededError(escrowIds.length, MAX_BATCH_SIZE)
  }

  const { hash } = await writeAndWait({
    publicClient,
    walletClient,
    address: muhavenEscrow,
    abi: muhavenEscrowAbi,
    functionName: 'redeemMultiple',
    args: [escrowIds],
    operation: 'MuHavenEscrow.redeemMultiple',
  })

  onProgress?.({
    stage: 'redeem',
    current: escrowIds.length,
    total: escrowIds.length,
    message: `Redeemed ${escrowIds.length} escrows`,
    txHash: hash,
  })

  return hash
}
