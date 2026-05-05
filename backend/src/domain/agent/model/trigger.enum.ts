/**
 * Triggers T-1..T-7 from ADR-0 — the seven distinct events that move a user
 * out of an autonomous tier into the transient `paused` state. The codes are
 * stable cleartext identifiers so they can be emitted in `RiskBreach` events
 * (P6) and surfaced in audit-log queries.
 */
export const Trigger = {
  /** T-1 user-initiated pause (chat / dashboard / Telegram) */
  ExplicitPause: 'T-1-pause',
  /** T-2 drawdown breach via off-chain `decryptForTx` on encrypted threshold */
  DrawdownBreach: 'T-2-drawdown',
  /** T-3 oracle deviation > threshold (NAV worker) */
  OracleDeviation: 'T-3-oracle',
  /** T-4 FHE attestation failure (`cofhejs.encrypt` rejection) */
  FheAttestationFail: 'T-4-fhe-attest',
  /** T-5 KYC revocation event — cascades across ALL surfaces */
  KycRevoked: 'T-5-kyc-revoke',
  /** T-6 account recovery / passkey rotation — cascades across ALL surfaces */
  AccountRecovery: 'T-6-account-recovery',
  /** T-7 session-key TTL expiry (block-level; UserOp simply reverts) */
  SessionKeyExpired: 'T-7-session-ttl',
} as const;

export type Trigger = (typeof Trigger)[keyof typeof Trigger];

export const TRIGGER_VALUES: readonly Trigger[] = [
  Trigger.ExplicitPause,
  Trigger.DrawdownBreach,
  Trigger.OracleDeviation,
  Trigger.FheAttestationFail,
  Trigger.KycRevoked,
  Trigger.AccountRecovery,
  Trigger.SessionKeyExpired,
] as const;

/**
 * Triggers whose effect must be applied to every surface for the user, not
 * just the surface where the event was detected.
 */
export const CASCADING_TRIGGERS: readonly Trigger[] = [
  Trigger.KycRevoked,
  Trigger.AccountRecovery,
] as const;

export function isCascading(trigger: Trigger): boolean {
  return (CASCADING_TRIGGERS as readonly Trigger[]).includes(trigger);
}

export function isTrigger(value: unknown): value is Trigger {
  return typeof value === 'string' && (TRIGGER_VALUES as readonly string[]).includes(value);
}
