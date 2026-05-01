/**
 * Service for InvestorRegistry contract interactions.
 *
 * Reads: publicClient.readContract()
 */

import { addresses } from '@/contracts/addresses'
import { investorRegistryAbi } from '@/contracts/abis'
import { contractRead } from './provider'

const CONTRACT = 'InvestorRegistry'
const addr = addresses.investorRegistry

export async function isInvestor(account: `0x${string}`): Promise<boolean> {
  return contractRead(addr, investorRegistryAbi, 'isInvestor', [account], CONTRACT) as Promise<boolean>
}

export async function investorCount(): Promise<bigint> {
  return contractRead(addr, investorRegistryAbi, 'investorCount', [], CONTRACT) as Promise<bigint>
}

export async function getInvestorsPaginated(
  offset: bigint,
  limit: bigint,
): Promise<`0x${string}`[]> {
  return contractRead(
    addr, investorRegistryAbi, 'getInvestorsPaginated', [offset, limit], CONTRACT,
  ) as Promise<`0x${string}`[]>
}

// ── Per-token holder enumeration (Wave 3.5) ────────────────────────────

/**
 * Count of MuHavenToken holders for a specific RWA. The snapshot phase
 * of a yield distribution iterates this list — `getHoldersPaginated` in
 * 50-sized chunks until `holderCount` is exhausted.
 */
export async function holderCount(token: `0x${string}`): Promise<bigint> {
  return contractRead(
    addr, investorRegistryAbi, 'holderCount', [token], CONTRACT,
  ) as Promise<bigint>
}

/**
 * Paginated holder list for a specific RWA token. Returns the slice
 * `[offset, offset + limit)` from the registry's per-token holder array.
 * Caller must walk `[0, holderCount(token))` to get the full set.
 */
export async function getHoldersPaginated(
  token: `0x${string}`,
  offset: bigint,
  limit: bigint,
): Promise<`0x${string}`[]> {
  return contractRead(
    addr, investorRegistryAbi, 'getHoldersPaginated', [token, offset, limit], CONTRACT,
  ) as Promise<`0x${string}`[]>
}
