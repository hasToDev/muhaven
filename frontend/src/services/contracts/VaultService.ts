/**
 * Service for MuHavenVault contract interactions.
 * Wrap ERC-20 RWA tokens into fhERC-20 and unwrap back.
 *
 * Reads: publicClient.readContract()
 * Writes: sendUserOperation() (gasless)
 */

import { addresses } from '@/contracts/addresses'
import { muHavenVaultAbi } from '@/contracts/abis'
import { contractRead, contractWrite } from './provider'
import type { TxHash } from './types'

const CONTRACT = 'MuHavenVault'
const addr = addresses.muHavenVault

// ── Reads ──────────────────────────────────────────────────────────

export async function getLockedBalance(user: `0x${string}`): Promise<bigint> {
  return contractRead(addr, muHavenVaultAbi, 'getLockedBalance', [user], CONTRACT) as Promise<bigint>
}

export async function totalLocked(): Promise<bigint> {
  return contractRead(addr, muHavenVaultAbi, 'totalLocked', [], CONTRACT) as Promise<bigint>
}

export async function minInvestment(): Promise<bigint> {
  return contractRead(addr, muHavenVaultAbi, 'minInvestment', [], CONTRACT) as Promise<bigint>
}

export async function underlyingToken(): Promise<`0x${string}`> {
  return contractRead(addr, muHavenVaultAbi, 'underlyingToken', [], CONTRACT) as Promise<`0x${string}`>
}

export async function paused(): Promise<boolean> {
  return contractRead(addr, muHavenVaultAbi, 'paused', [], CONTRACT) as Promise<boolean>
}

// ── Writes ─────────────────────────────────────────────────────────

export async function wrap(amount: bigint): Promise<TxHash> {
  return contractWrite(addr, muHavenVaultAbi, 'wrap', [amount], CONTRACT)
}

export async function unwrap(amount: bigint): Promise<TxHash> {
  return contractWrite(addr, muHavenVaultAbi, 'unwrap', [amount], CONTRACT)
}
