/**
 * Service for MuHavenEscrow contract interactions.
 *
 * Reads: publicClient.readContract()
 * Writes: sendUserOperation() (gasless)
 *
 * Scope (Phase 19D.7): investor-side redeem flow only. Issuer-side batchCreate
 * is driven by the CLI pipeline (`scripts/test-e2e-sdk.ts`) for the hackathon
 * demo — frontend orchestration of the full distribute pipeline is deferred.
 */

import { addresses } from '@/contracts/addresses'
import { muhavenEscrowAbi } from '@/contracts/abis'
import { contractRead, contractWrite } from './provider'
import type { TxHash } from './types'

const CONTRACT = 'MuHavenEscrow'
const addr = addresses.muhavenEscrow

// ── Reads ──────────────────────────────────────────────────────────

export async function exists(escrowId: bigint): Promise<boolean> {
  return contractRead(addr, muhavenEscrowAbi, 'exists', [escrowId], CONTRACT) as Promise<boolean>
}

export async function getResolver(escrowId: bigint): Promise<`0x${string}`> {
  return contractRead(
    addr, muhavenEscrowAbi, 'getResolver', [escrowId], CONTRACT,
  ) as Promise<`0x${string}`>
}

export async function total(): Promise<bigint> {
  return contractRead(addr, muhavenEscrowAbi, 'total', [], CONTRACT) as Promise<bigint>
}

// ── Writes ─────────────────────────────────────────────────────────

/**
 * Redeem a single escrow. Uses MuHavenEscrow's silent-failure AND chain —
 * if the caller isn't the encrypted owner, the tx succeeds but pays zero.
 * Callers should verify success by (a) observing a ConfidentialTransfer
 * event on PUSDC in the receipt, or (b) polling the yield record's status
 * in the backend (which watches EscrowRedeemed events and updates status
 * only after a matching cUSDC movement is observed).
 */
export async function redeem(escrowId: bigint): Promise<TxHash> {
  return contractWrite(addr, muhavenEscrowAbi, 'redeem', [escrowId], CONTRACT)
}

/**
 * Redeem multiple escrows in a single tx. Non-existent IDs are silently
 * skipped on-chain (intentional asymmetry with single-redeem — see
 * MuHavenEscrow.redeem NatSpec).
 */
export async function redeemMultiple(escrowIds: bigint[]): Promise<TxHash> {
  return contractWrite(
    addr, muhavenEscrowAbi, 'redeemMultiple', [escrowIds], CONTRACT,
  )
}
