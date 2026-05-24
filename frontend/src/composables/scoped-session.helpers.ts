/**
 * Wave 5 Option D · Commit 4 — pure helpers for the active-Scoped-session
 * surfaces (dashboard banner + PolicyTransitionPage revoke zone).
 *
 * Keep this file PURE — no `vue`, no `vue-router`. The `useScopedSession`
 * composable + the banner / page import these; the unit tests import them
 * directly without mounting anything.
 */

import type { ScopedSessionResponseDto } from '@/services/api'

/**
 * Remaining seconds before a Scoped session's on-chain TimestampPolicy
 * expires. `validUntilSec` is epoch-seconds (the broker's TTL ceiling);
 * `nowMs` is `Date.now()`. Floors at 0 (never negative).
 */
export function scopedExpiresInSec(validUntilSec: number, nowMs: number): number {
  if (!Number.isFinite(validUntilSec)) return 0
  return Math.max(0, Math.floor(validUntilSec - nowMs / 1000))
}

/**
 * Human countdown for the expiry. `<=0 → 'expired'`. Shows the two most
 * significant units (h+m, or m+s, or s) so the banner stays compact.
 */
export function formatExpiresIn(sec: number): string {
  if (sec <= 0) return 'expired'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/**
 * `0x1234…cdef` short form for a 0x address. Returns `—` for empty input
 * and passes through anything already ≤10 chars unchanged.
 */
export function signerPrefix(addr: string | null | undefined): string {
  if (!addr) return '—'
  return addr.length <= 10 ? addr : `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/**
 * Display form for the 4-byte permissionId (`0x` + 8 hex = 10 chars). It's
 * already short, so we show it whole and only ellipsize a longer-than-
 * expected value defensively.
 */
export function permissionIdPrefix(pid: string | null | undefined): string {
  if (!pid) return '—'
  return pid.length <= 10 ? pid : `${pid.slice(0, 10)}…`
}

/**
 * Format a uint256 base-6 (mhUSDC) decimal STRING for display. Trailing
 * zeros trimmed (`100500000 → '100.5'`). Returns the raw input on a parse
 * failure rather than throwing — this is display-only, never a gate.
 */
export function formatMhUsdc6(base6: string | null | undefined): string {
  if (base6 === null || base6 === undefined || base6 === '') return '0'
  let v: bigint
  try {
    v = BigInt(base6)
  } catch {
    return base6
  }
  const whole = v / 1_000_000n
  const frac = v % 1_000_000n
  if (frac === 0n) return whole.toString()
  return `${whole.toString()}.${frac.toString().padStart(6, '0').replace(/0+$/, '')}`
}

/**
 * Whether a fetched session should be surfaced as ACTIVE. The backend's
 * `GetActiveScopedSessionUseCase` already filters to `status='active'`,
 * but the TTL may have lapsed between fetch and render — so we additionally
 * require the countdown to be live. Defensive against a stale row.
 */
export function isSessionLive(
  session: ScopedSessionResponseDto | null,
  nowMs: number,
): boolean {
  if (!session) return false
  if (session.status !== 'active') return false
  return scopedExpiresInSec(session.validUntilSec, nowMs) > 0
}
