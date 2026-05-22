/**
 * Lifecycle status for a row in `agent_scoped_sessions` (Wave 5 Path D
 * Slice 2 Commit 2.A · RD-3).
 *
 * Forward-only state machine — same shape as `agent_device_code_status`:
 *   active     → mint side; the broker MAY use this snapshot if loaded
 *   revoked    → terminal; user-initiated DELETE
 *   expired    → terminal; lazy sweep flipped a past-valid-until row
 *
 * Reverse transitions (`revoked → active`, etc.) are forbidden. A user
 * who wants scoped autonomy back after revoking minteds a new session
 * (new sessionId → new row).
 */
export const ScopedSessionStatus = {
  Active: 'active',
  Revoked: 'revoked',
  Expired: 'expired',
} as const;

export type ScopedSessionStatus =
  (typeof ScopedSessionStatus)[keyof typeof ScopedSessionStatus];

export const SCOPED_SESSION_STATUS_VALUES: readonly ScopedSessionStatus[] = [
  ScopedSessionStatus.Active,
  ScopedSessionStatus.Revoked,
  ScopedSessionStatus.Expired,
] as const;

export function isScopedSessionStatus(value: unknown): value is ScopedSessionStatus {
  return (
    typeof value === 'string' &&
    (SCOPED_SESSION_STATUS_VALUES as readonly string[]).includes(value)
  );
}
