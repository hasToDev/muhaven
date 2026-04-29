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
 * (`wrap` / `unwrap` / `transfer`) consumers should reach into the SDK's
 * `StableClient` instead, since those calls need a cofhe-encrypted input
 * and an `ephemeralEOA` grant. This service exposes:
 *   - `confidentialBalanceOf(addr)` — encrypted handle for decrypt-for-view
 *   - `isOperator(holder, spender)` — pre-flight check for transferFrom
 *   - `setOperator(spender, until)` — operator approval for issuer flows
 *   - `paused()` — emergency-pause readout for the dev-mode banner
 *   - `refreshDecryptGrant(eph)` — self-service ACL refresh (ADR-042 mirror)
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
