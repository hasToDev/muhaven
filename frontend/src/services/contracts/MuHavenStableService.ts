/**
 * Service for `MuHavenStable` (mhUSDC) — the Phase 7.5 confidential-USDC
 * wrapper that owns the modern `euint64` ABI + ephemeralEOA-aware ACL
 * grants (`MHUSD_WRAPPER_PLAN.md` + ADR-041).
 *
 * Frontend hot-path PUSDC reads + writes go through here. Legacy PUSDC
 * surfaces only on the CashPage advanced view (`LegacyPusdcService`).
 *
 * This service stays close to the metal — direct ABI calls via
 * `contractRead` / `contractWrite`, no SDK indirection — to keep parity
 * with the existing service layer style. For session/UserOp-aware writes
 * (`wrap` / `unwrap` / `withdrawToUsdc` / `transfer`) consumers should
 * reach into the SDK's `StableClient` instead, since those calls need a
 * cofhe-encrypted input and an `ephemeralEOA` grant. This service exposes:
 *   - `confidentialBalanceOf(addr)` — encrypted handle for decrypt-for-view
 *   - `isOperator(holder, spender)` — pre-flight check for transferFrom
 *   - `setOperator(spender, until)` — operator approval for issuer flows
 *   - `paused()` — emergency-pause readout for the dev-mode banner
 *   - `refreshDecryptGrant(eph)` — self-service ACL refresh (ADR-042 mirror)
 *
 * Wave 5 W3 (direct mhUSDC → USDC exit) — read helpers for the async
 * pending-claim surface in CashPage's Withdraw flow:
 *   - `getUserWithdrawClaims(addr)` — re-discover in-flight claims on mount
 *   - `getWithdrawClaim(claimId)` — per-claim record (recipient + handle +
 *     amount-once-claimed + claimed-flag)
 *   - `withdrawDecryptResult(claimId)` — poll the coprocessor decrypt for a
 *     claim; returns `{ amount, ready }`
 *   - `usdcReserveBalance()` — readout for "is the reserve healthy?" hints
 *   - `claimsPaused()` — settlement kill-switch state (separate from the
 *     wrap/transfer `paused()`)
 *   - `usdc()` — configured USDC reserve token address (zero until owner sets it)
 */

import type { Address } from 'viem'
import { muHavenStableAbi } from '@muhaven/sdk'
import { v35Addresses, isZeroAddress } from '@/contracts/addresses'
import { contractRead, contractWrite } from './provider'
import type { TxHash } from './types'

const CONTRACT = 'MuHavenStable'

/**
 * Throw if the wrapper is unconfigured (zero-address). Surfaced once at
 * the call site so UI consumers can branch on a clean pre-condition
 * rather than swallowing every read failure.
 */
function requireWrapperAddress(): Address {
  const a = v35Addresses.muHavenStable
  if (isZeroAddress(a)) {
    throw new Error(
      'MuHavenStable not configured for this build — set VITE_MUHAVEN_STABLE_ADDRESS or wait for Phase 8 cutover',
    )
  }
  return a
}

/** True iff the wrapper address is set; false on Wave 3 / pre-cutover envs. */
export function isAvailable(): boolean {
  return !isZeroAddress(v35Addresses.muHavenStable)
}

export function address(): Address {
  return v35Addresses.muHavenStable
}

// ── Reads ────────────────────────────────────────────────────────────

/**
 * Encrypted mhUSDC balance handle (`euint64` ctHash, hex-encoded
 * `bytes32`). Pass to `useFhe.decryptMhUsdcForView` for plaintext —
 * ACL gates ensure only the holder's kernel + the active session's
 * ephemeralEOA can decrypt. The auto-refresh fallback re-binds ACL
 * to the session signer if the first decrypt 403s.
 */
export async function confidentialBalanceOf(account: Address): Promise<`0x${string}`> {
  return contractRead(
    requireWrapperAddress(),
    muHavenStableAbi,
    'confidentialBalanceOf',
    [account],
    CONTRACT,
  ) as Promise<`0x${string}`>
}

export async function isOperator(holder: Address, spender: Address): Promise<boolean> {
  return contractRead(
    requireWrapperAddress(),
    muHavenStableAbi,
    'isOperator',
    [holder, spender],
    CONTRACT,
  ) as Promise<boolean>
}

/** Emergency-pause flag. When `true`, every wrapper mutation reverts. */
export async function paused(): Promise<boolean> {
  return contractRead(
    requireWrapperAddress(),
    muHavenStableAbi,
    'paused',
    [],
    CONTRACT,
  ) as Promise<boolean>
}

// ── Wave 5 W3 — direct USDC-exit reads ────────────────────────────────

/**
 * Pending withdrawal-claim ids for `account`. Empty array if none — returned
 * by the contract verbatim from `_userWithdrawClaims[account]`. Settled
 * claims are pruned from this list at `claimUsdc` time (swap-pop), so the
 * frontend re-mounts can rebuild the "in-flight" view in one read.
 */
export async function getUserWithdrawClaims(account: Address): Promise<readonly bigint[]> {
  return contractRead(
    requireWrapperAddress(),
    muHavenStableAbi,
    'getUserWithdrawClaims',
    [account],
    CONTRACT,
  ) as Promise<readonly bigint[]>
}

/**
 * Per-claim record — `{ to, handle, amount, claimed }`. `to == zeroAddress`
 * means "no such claim" (defensive); `amount` is 0 until `claimUsdc`
 * settles it. The `handle` is the burned `euint64` ciphertext (what the
 * coprocessor decrypts); it's exposed for completeness but UI consumers
 * rarely need it — `withdrawDecryptResult` is the polling primitive.
 */
export async function getWithdrawClaim(claimId: bigint): Promise<{
  to: Address
  handle: `0x${string}`
  amount: bigint
  claimed: boolean
}> {
  return contractRead(
    requireWrapperAddress(),
    muHavenStableAbi,
    'getWithdrawClaim',
    [claimId],
    CONTRACT,
  ) as Promise<{ to: Address; handle: `0x${string}`; amount: bigint; claimed: boolean }>
}

/**
 * Poll the coprocessor decrypt for a withdrawal claim. Returns
 * `{ amount, ready }`: `ready` flips `true` once decryption lands, at
 * which point `claimUsdc(claimId)` will settle. `(0n, false)` for an
 * unknown claim. Designed for a 5–15s frontend poll loop while pending.
 */
export async function withdrawDecryptResult(claimId: bigint): Promise<{
  amount: bigint
  ready: boolean
}> {
  const [amount, ready] = (await contractRead(
    requireWrapperAddress(),
    muHavenStableAbi,
    'withdrawDecryptResult',
    [claimId],
    CONTRACT,
  )) as [bigint, boolean]
  return { amount, ready }
}

/** Current USDC reserve balance held by the wrapper (0 if reserve unset). */
export async function usdcReserveBalance(): Promise<bigint> {
  return contractRead(
    requireWrapperAddress(),
    muHavenStableAbi,
    'usdcReserveBalance',
    [],
    CONTRACT,
  ) as Promise<bigint>
}

/**
 * Settlement kill-switch state. Distinct from `paused()`:
 *   - `paused()` blocks wrap / transfer / `withdrawToUsdc` (request leg);
 *     `claimUsdc` still settles.
 *   - `claimsPaused()` blocks ONLY `claimUsdc`, so the owner can freeze
 *     USDC outflow in a reserve emergency without freezing deposits.
 * UI surfaces this in the Withdraw flow's "Claim USDC" button (disable +
 * tooltip "settlement temporarily halted").
 */
export async function claimsPaused(): Promise<boolean> {
  return contractRead(
    requireWrapperAddress(),
    muHavenStableAbi,
    'claimsPaused',
    [],
    CONTRACT,
  ) as Promise<boolean>
}

/** Configured USDC reserve token address (zero address until the owner sets it). */
export async function usdcReserveToken(): Promise<Address> {
  return contractRead(
    requireWrapperAddress(),
    muHavenStableAbi,
    'usdc',
    [],
    CONTRACT,
  ) as Promise<Address>
}

// ── Writes ───────────────────────────────────────────────────────────

/**
 * Grant `spender` operator on the caller's mhUSDC for `until` (uint48
 * unix timestamp). One-shot per (holder, spender) pair until expiry.
 * Required before any `transferFrom(caller, ...)` call lands.
 */
export async function setOperator(spender: Address, until: bigint): Promise<TxHash> {
  return contractWrite(
    requireWrapperAddress(),
    muHavenStableAbi,
    'setOperator',
    [spender, until],
    CONTRACT,
  )
}

/**
 * Re-grant FHE ACL on the caller's current balance handle to
 * `ephemeralEOA`. Mirror of `MuHavenToken.refreshDecryptGrant` (ADR-042)
 * — closes the kernel-only-grant gap when a fresh session lands on a
 * page that needs to decrypt the holder's mhUSDC balance without first
 * issuing a write op.
 */
export async function refreshDecryptGrant(ephemeralEOA: Address): Promise<TxHash> {
  return contractWrite(
    requireWrapperAddress(),
    muHavenStableAbi,
    'refreshDecryptGrant',
    [ephemeralEOA],
    CONTRACT,
  )
}

/**
 * Phase 9.A · Option Z follow-up — re-grant FHE ACL on a HISTORICAL audit
 * handle (Wrap / Unwrap event amount) to a fresh `ephemeralEOA`. Required
 * when a user re-logs in on a new tab/device: ZeroDev mints a fresh eph
 * per session, but the wrap-time grant binds to the session-of-origin,
 * so the new eph 403s on `decryptForView`.
 *
 * Auth gate sits inside the contract — `FHE.isAllowed(handle, msg.sender)`
 * — so only the rightful owner (the kernel that originally wrapped) can
 * re-grant. Strangers passing in someone else's audit handle revert with
 * `NotAuditHandleOwner`.
 */
export async function refreshAuditGrant(
  handle: `0x${string}`,
  ephemeralEOA: Address,
): Promise<TxHash> {
  return contractWrite(
    requireWrapperAddress(),
    muHavenStableAbi,
    'refreshAuditGrant',
    [handle, ephemeralEOA],
    CONTRACT,
  )
}
