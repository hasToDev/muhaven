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
