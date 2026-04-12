/**
 * Service for ERC3643KYCAdapter contract interactions.
 *
 * Reads: publicClient.readContract()
 * Writes: sendUserOperation() (gasless)
 */

import { addresses } from '@/contracts/addresses'
import { kycAdapterAbi } from '@/contracts/abis'
import { contractRead, contractWrite } from './provider'
import type { TxHash } from './types'

const CONTRACT = 'ERC3643KYCAdapter'
const addr = addresses.kycAdapter

// ── Reads ──────────────────────────────────────────────────────────

export async function isEligible(account: `0x${string}`): Promise<boolean> {
  return contractRead(addr, kycAdapterAbi, 'isEligible', [account], CONTRACT) as Promise<boolean>
}

export async function isEligibleForTier(account: `0x${string}`, tier: bigint): Promise<boolean> {
  return contractRead(
    addr, kycAdapterAbi, 'isEligibleForTier', [account, tier], CONTRACT,
  ) as Promise<boolean>
}

export async function isWhitelisted(account: `0x${string}`): Promise<boolean> {
  return contractRead(addr, kycAdapterAbi, 'isWhitelisted', [account], CONTRACT) as Promise<boolean>
}

export async function isAccredited(account: `0x${string}`): Promise<boolean> {
  return contractRead(addr, kycAdapterAbi, 'isAccredited', [account], CONTRACT) as Promise<boolean>
}

export async function providerName(): Promise<string> {
  return contractRead(addr, kycAdapterAbi, 'providerName', [], CONTRACT) as Promise<string>
}

// ── Writes ─────────────────────────────────────────────────────────

export async function addToWhitelist(account: `0x${string}`): Promise<TxHash> {
  return contractWrite(addr, kycAdapterAbi, 'addToWhitelist', [account], CONTRACT)
}

export async function removeFromWhitelist(account: `0x${string}`): Promise<TxHash> {
  return contractWrite(addr, kycAdapterAbi, 'removeFromWhitelist', [account], CONTRACT)
}

export async function batchAddToWhitelist(accounts: `0x${string}`[]): Promise<TxHash> {
  return contractWrite(addr, kycAdapterAbi, 'batchAddToWhitelist', [accounts], CONTRACT)
}

export async function addToAccreditedList(account: `0x${string}`): Promise<TxHash> {
  return contractWrite(addr, kycAdapterAbi, 'addToAccreditedList', [account], CONTRACT)
}

export async function removeFromAccreditedList(account: `0x${string}`): Promise<TxHash> {
  return contractWrite(addr, kycAdapterAbi, 'removeFromAccreditedList', [account], CONTRACT)
}
