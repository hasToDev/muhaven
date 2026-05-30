/**
 * Generic ERC-20 service for standard token interactions.
 * Used for underlying RWA tokens (vault wrap flow) and USDC.
 *
 * Reads: publicClient.readContract()
 * Writes: sendUserOperation() (gasless)
 */

import { erc20Abi } from '@/contracts/abis'
import { contractRead, contractWrite } from './provider'
import type { TxHash } from './types'

// ── Reads ──────────────────────────────────────────────────────────

export async function balanceOf(
  tokenAddress: `0x${string}`,
  account: `0x${string}`,
): Promise<bigint> {
  return contractRead(tokenAddress, erc20Abi, 'balanceOf', [account], 'ERC20') as Promise<bigint>
}

export async function allowance(
  tokenAddress: `0x${string}`,
  owner: `0x${string}`,
  spender: `0x${string}`,
): Promise<bigint> {
  return contractRead(
    tokenAddress, erc20Abi, 'allowance', [owner, spender], 'ERC20',
  ) as Promise<bigint>
}

export async function decimals(tokenAddress: `0x${string}`): Promise<number> {
  return contractRead(tokenAddress, erc20Abi, 'decimals', [], 'ERC20') as Promise<number>
}

export async function symbol(tokenAddress: `0x${string}`): Promise<string> {
  return contractRead(tokenAddress, erc20Abi, 'symbol', [], 'ERC20') as Promise<string>
}

export async function name(tokenAddress: `0x${string}`): Promise<string> {
  return contractRead(tokenAddress, erc20Abi, 'name', [], 'ERC20') as Promise<string>
}

// ── Writes ─────────────────────────────────────────────────────────

export async function approve(
  tokenAddress: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint,
): Promise<TxHash> {
  return contractWrite(tokenAddress, erc20Abi, 'approve', [spender, amount], 'ERC20')
}

/**
 * Plain ERC-20 transfer — moves `amount` base units of `tokenAddress` from the
 * connected kernel smart account to `to`, dispatched as a single gasless
 * UserOp. Used by the CashPage "Send" flow to send cleartext USDC out to an
 * arbitrary external address. NO FHE, no SDK, no async coprocessor leg — this
 * is the cleartext-money analog of the confidential `TokenService` transfer.
 *
 * The caller owns validation (valid/non-zero/non-self recipient, positive
 * amount, balance cap) — this service just encodes + sends.
 */
export async function transfer(
  tokenAddress: `0x${string}`,
  to: `0x${string}`,
  amount: bigint,
): Promise<TxHash> {
  return contractWrite(tokenAddress, erc20Abi, 'transfer', [to, amount], 'ERC20')
}
