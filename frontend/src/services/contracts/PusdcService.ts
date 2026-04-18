/**
 * Service for ConfidentialUSDC (PUSDC) contract interactions.
 *
 * Only covers the plaintext surface the frontend needs:
 *   - `balanceOf(addr)` — plaintext cleartext balance (distinct from
 *     `confidentialBalanceOf` which returns an encrypted handle)
 *   - `isOperator(holder, spender)` — operator approval check
 *   - `setOperator(spender, until)` — self-operator approval, issued as
 *     a UserOp from the caller's smart account. Required before the
 *     YieldDistributor can pull PUSDC via `confidentialTransferFrom`.
 */

import type { Address } from 'viem'
import { addresses } from '@/contracts/addresses'
import { pusdcAbi } from '@/contracts/abis'
import { contractRead, contractWrite } from './provider'
import type { TxHash } from './types'

const CONTRACT = 'ConfidentialUSDC'
const addr = addresses.pusdc

// ── Reads ──────────────────────────────────────────────────────────

export async function balanceOf(account: Address): Promise<bigint> {
  return contractRead(addr, pusdcAbi, 'balanceOf', [account], CONTRACT) as Promise<bigint>
}

export async function isOperator(holder: Address, spender: Address): Promise<boolean> {
  return contractRead(
    addr, pusdcAbi, 'isOperator', [holder, spender], CONTRACT,
  ) as Promise<boolean>
}

// ── Writes ─────────────────────────────────────────────────────────

/**
 * Grant `spender` operator access on the caller's PUSDC balance.
 * `until` is an absolute unix timestamp (uint48).
 *
 * Issued as a UserOp — the operator mapping is keyed by `msg.sender`,
 * so this must run as the smart account's own tx, not a deployer-side
 * one. Typically called once per smart account; expiry 1 year out.
 */
export async function setOperator(spender: Address, until: bigint): Promise<TxHash> {
  return contractWrite(addr, pusdcAbi, 'setOperator', [spender, until], CONTRACT)
}
