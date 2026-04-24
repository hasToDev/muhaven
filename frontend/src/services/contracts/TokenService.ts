/**
 * Service for MuHavenToken (fhERC-20) contract interactions.
 *
 * Reads: publicClient.readContract()
 * Writes: sendUserOperation() (gasless)
 */

import { addresses } from '@/contracts/addresses'
import { muHavenTokenAbi } from '@/contracts/abis'
import { contractRead, contractWrite, pollUntil } from './provider'
import type { EncryptedInput, BalanceDecryptResult, TxHash } from './types'

const CONTRACT = 'MuHavenToken'
const addr = addresses.muHavenToken

// ── Reads ──────────────────────────────────────────────────────────

export async function name(): Promise<string> {
  return contractRead(addr, muHavenTokenAbi, 'name', [], CONTRACT) as Promise<string>
}

export async function symbol(): Promise<string> {
  return contractRead(addr, muHavenTokenAbi, 'symbol', [], CONTRACT) as Promise<string>
}

export async function decimals(): Promise<number> {
  return contractRead(addr, muHavenTokenAbi, 'decimals', [], CONTRACT) as Promise<number>
}

export async function encryptedBalanceOf(account: `0x${string}`): Promise<`0x${string}`> {
  return contractRead(addr, muHavenTokenAbi, 'encryptedBalanceOf', [account], CONTRACT) as Promise<`0x${string}`>
}

export async function encryptedTotalSupply(): Promise<`0x${string}`> {
  return contractRead(addr, muHavenTokenAbi, 'encryptedTotalSupply', [], CONTRACT) as Promise<`0x${string}`>
}

export async function getBalanceDecryptResult(account: `0x${string}`): Promise<BalanceDecryptResult> {
  const [result, decrypted] = await contractRead(
    addr, muHavenTokenAbi, 'getBalanceDecryptResult', [account], CONTRACT,
  ) as [bigint, boolean]
  return { result, decrypted }
}

export async function totalSupplyPublic(): Promise<boolean> {
  return contractRead(addr, muHavenTokenAbi, 'totalSupplyPublic', [], CONTRACT) as Promise<boolean>
}

export async function paused(): Promise<boolean> {
  return contractRead(addr, muHavenTokenAbi, 'paused', [], CONTRACT) as Promise<boolean>
}

export async function owner(): Promise<`0x${string}`> {
  return contractRead(addr, muHavenTokenAbi, 'owner', [], CONTRACT) as Promise<`0x${string}`>
}

export async function issuer(): Promise<`0x${string}`> {
  return contractRead(addr, muHavenTokenAbi, 'issuer', [], CONTRACT) as Promise<`0x${string}`>
}

export async function isMinter(account: `0x${string}`): Promise<boolean> {
  return contractRead(addr, muHavenTokenAbi, 'minters', [account], CONTRACT) as Promise<boolean>
}

// ── Writes ─────────────────────────────────────────────────────────

export async function mint(to: `0x${string}`, encrypted: EncryptedInput): Promise<TxHash> {
  return contractWrite(addr, muHavenTokenAbi, 'mint', [to, encrypted], CONTRACT)
}

export async function transfer(to: `0x${string}`, encrypted: EncryptedInput): Promise<TxHash> {
  return contractWrite(addr, muHavenTokenAbi, 'transfer', [to, encrypted], CONTRACT)
}

/**
 * Wave 3.5 canonical transfer — `transfer(to, encryptedAmount, ephemeralEOA)`.
 * The contract grants FHE-decrypt access on the sender's post-transfer balance
 * handle to `ephemeralEOA` (ADR-021). The overload is resolved by viem via
 * arg count.
 */
export async function transferWithEphemeral(
  to: `0x${string}`,
  encrypted: EncryptedInput,
  ephemeralEOA: `0x${string}`,
): Promise<TxHash> {
  return contractWrite(addr, muHavenTokenAbi, 'transfer', [to, encrypted, ephemeralEOA], CONTRACT)
}

export async function transferFrom(
  from: `0x${string}`,
  to: `0x${string}`,
  encrypted: EncryptedInput,
): Promise<TxHash> {
  return contractWrite(addr, muHavenTokenAbi, 'transferFrom', [from, to, encrypted], CONTRACT)
}

export async function approve(spender: `0x${string}`, encrypted: EncryptedInput): Promise<TxHash> {
  return contractWrite(addr, muHavenTokenAbi, 'approve', [spender, encrypted], CONTRACT)
}

export async function requestBalanceDecrypt(): Promise<TxHash> {
  return contractWrite(addr, muHavenTokenAbi, 'requestBalanceDecrypt', [], CONTRACT)
}

// ── Convenience: full decrypt flow ─────────────────────────────────

/**
 * Request + poll for decrypted balance.
 * Sends the decrypt request tx, then polls getBalanceDecryptResult until ready.
 */
export async function decryptBalance(
  account: `0x${string}`,
  { intervalMs = 3000, maxAttempts = 20 } = {},
): Promise<bigint> {
  await requestBalanceDecrypt()

  const result = await pollUntil(
    () => getBalanceDecryptResult(account),
    r => r.decrypted,
    { intervalMs, maxAttempts, label: `balance decrypt for ${account}` },
  )
  return result.result
}
