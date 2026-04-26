/**
 * Service for legacy ConfidentialUSDC (PUSDC) — the pre-v0.1.0 ReineiraOS
 * deployment used as the underlying collateral for the Phase 7.5
 * `MuHavenStable` wrapper.
 *
 * Phase 7.5 (`MHUSD_WRAPPER_PLAN.md` + ADR-041) replaced Wave 3.5's hot
 * path with `MuHavenStableService` — this file is intentionally kept on
 * the slow path and exposes only:
 *   - `balanceOf(addr)` — cleartext shadow balance, used for the WrapPage
 *     "your legacy PUSDC" readout
 *   - `confidentialBalanceOf(addr)` — ctHash for legacy decrypt fallback
 *   - `isOperator(holder, spender)` — used to check whether the wrapper
 *     already has operator approval before initiating a wrap
 *   - `setOperator(spender, until)` — once-per-session approval for the
 *     wrapper's `wrap` flow (`MuHavenStable` calls
 *     `legacyPusdc.confidentialTransferFrom(holder, mhUSDC, amount)` via
 *     the ADR-008 selector path)
 *
 * No write paths beyond `setOperator` are exposed — investors should
 * transact in mhUSDC, not legacy PUSDC, for everything past Phase 7.5.
 *
 * Wave 3 callers can still import from `PusdcService.ts`, which now
 * re-exports this module for back-compat. New code should import from
 * here directly.
 */

import type { Address } from 'viem'
import { addresses } from '@/contracts/addresses'
import { pusdcAbi } from '@/contracts/abis'
import { contractRead, contractWrite } from './provider'
import type { TxHash } from './types'

const CONTRACT = 'ConfidentialUSDC (legacy)'
const addr = addresses.pusdc

// ── Reads ──────────────────────────────────────────────────────────

export async function balanceOf(account: Address): Promise<bigint> {
  return contractRead(addr, pusdcAbi, 'balanceOf', [account], CONTRACT) as Promise<bigint>
}

/**
 * Read the encrypted balance handle (euint64). Returns a uint256-packed ctHash
 * — pass to `useFhe.decryptUint64ForView` for plaintext. The legacy contract
 * grants ACL on the recipient *kernel* on `_doTransfer`, so kernel-only
 * sessions can decrypt; ephemeralEOA sessions cannot. This is the gap that
 * Phase 7.5's MuHavenStable wrapper closes.
 */
export async function confidentialBalanceOf(account: Address): Promise<bigint> {
  return contractRead(
    addr, pusdcAbi, 'confidentialBalanceOf', [account], CONTRACT,
  ) as Promise<bigint>
}

export async function isOperator(holder: Address, spender: Address): Promise<boolean> {
  return contractRead(
    addr, pusdcAbi, 'isOperator', [holder, spender], CONTRACT,
  ) as Promise<boolean>
}

// ── Writes ─────────────────────────────────────────────────────────

/**
 * Grant `spender` operator access on the caller's legacy PUSDC. Used
 * once per session before a `MuHavenStable.wrap` so the wrapper can
 * pull legacy PUSDC via the ADR-008
 * `confidentialTransferFrom(address,address,uint256)` selector.
 */
export async function setOperator(spender: Address, until: bigint): Promise<TxHash> {
  return contractWrite(addr, pusdcAbi, 'setOperator', [spender, until], CONTRACT)
}

/**
 * Wrap cleartext USDC into encrypted PUSDC. The PUSDC contract pulls
 * `amount` USDC from the caller via `safeTransferFrom`, so the caller
 * must have ERC-20 approved the PUSDC contract for at least `amount`
 * first (use `Erc20Service.approve(addresses.usdc, addresses.pusdc, ...)`).
 *
 * Used by the WrapPage Cash flow (USDC → PUSDC → mhUSDC) so investors
 * who only hold USDC don't have to manually deal with the PUSDC layer.
 */
export async function wrap(to: Address, amount: bigint): Promise<TxHash> {
  return contractWrite(addr, pusdcAbi, 'wrap', [to, amount], CONTRACT)
}
