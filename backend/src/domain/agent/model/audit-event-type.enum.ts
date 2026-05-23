/**
 * Closed enum of agent audit event categories. Every state change written to
 * `agent_audit_events` carries one of these. The set is small and append-only
 * so the WORM property is easy to reason about and so audit-log queries can
 * filter cheaply by `event_type`.
 *
 * Extending this enum requires a Drizzle migration (Postgres `pgEnum` change)
 * AND an ADR amendment if the new event has different privacy semantics.
 */
export const AuditEventType = {
  /** Tier transition (incl. transient → paused) */
  TierChanged: 'tier_changed',
  /** Pause action — explicit or trigger-driven */
  Paused: 'paused',
  /** Resume from paused → advisory after cleanup */
  Resumed: 'resumed',
  /** Cron policy-engine tick (success or soft-fail) */
  CronTick: 'cron_tick',
  /** Single-use confirmation token issued (R-3) */
  ConfirmTokenIssued: 'confirm_token_issued',
  /** Single-use confirmation token consumed (R-3) */
  ConfirmTokenConsumed: 'confirm_token_consumed',
  /** Permit grant/revocation that the agent surface negotiated (R-1, R-8) */
  PermitGranted: 'permit_granted',
  PermitRevoked: 'permit_revoked',
  /** ZeroDev session-key validator install/uninstall (R-6) */
  ValidatorInstalled: 'validator_installed',
  ValidatorUninstalled: 'validator_uninstalled',
  /** KYC revocation webhook received — drives T-5 cascade */
  KycRevocationReceived: 'kyc_revocation_received',
  /** Risk Q&A complete — gate for ConfirmPerAction → PolicyBound */
  RiskQuestionnaireComplete: 'risk_questionnaire_complete',
  /** Wave 5 Path D Slice 2 — scoped-session row inserted (mirror of
   *  the broker keystore's per-session JSON). Enum value lands in
   *  Commit 2.A; emission from MintScopedSessionUseCase wires in
   *  Commit 2.B alongside the MCP auto-sync. */
  ScopedSessionMinted: 'scoped_session_minted',
  /** User-initiated revocation via DELETE /policy/scoped-session/:id. */
  ScopedSessionRevoked: 'scoped_session_revoked',
  /** Lazy expiry sweep (cron, future Slice) flips a past-valid-until row. */
  ScopedSessionExpired: 'scoped_session_expired',
  /**
   * Wave 5 Option D · Commit 1 — one-shot operator-driven revoke of
   * every active Scoped session that was minted under the pre-D1
   * narrow CallPolicy (`subscription.purchase`-only).
   *
   * After D-1 broadens the on-chain envelope to mirror the legacy
   * session-key allowlist (minus `muHavenToken.transfer`), the
   * `permissionId` derived from `keccak256(policies+signer)` changes:
   * pre-D1 rows have a narrow permissionId, post-D1 rows have a
   * broad permissionId. Leaving the pre-D1 rows active would let the
   * broker keep signing under the OLD policy AND let the MCP server
   * pick up the stale snapshot on auto-sync. The migration use-case
   * (`RevokeAllPreOptionDScopedSessionsUseCase`) flips every active
   * row to `status='revoked'` + emits one of these audit rows per
   * affected row. Operator + user re-walk the ceremony to mint a
   * fresh session bound to the broader policy.
   *
   * Distinguished from `ScopedSessionRevoked` (user-initiated DELETE)
   * for forensic clarity: a "this session was forcibly retired due
   * to a server-side policy change" event is a different signal from
   * "the user clicked revoke". Audit queries that pair mint↔revoke
   * by surface/sessionId still correlate, but the `event_type`
   * column distinguishes the cause.
   */
  ScopedSessionRevokedByPolicyMigration: 'scoped_session_revoked_by_policy_migration',
} as const;

export type AuditEventType = (typeof AuditEventType)[keyof typeof AuditEventType];

export const AUDIT_EVENT_TYPE_VALUES: readonly AuditEventType[] = [
  AuditEventType.TierChanged,
  AuditEventType.Paused,
  AuditEventType.Resumed,
  AuditEventType.CronTick,
  AuditEventType.ConfirmTokenIssued,
  AuditEventType.ConfirmTokenConsumed,
  AuditEventType.PermitGranted,
  AuditEventType.PermitRevoked,
  AuditEventType.ValidatorInstalled,
  AuditEventType.ValidatorUninstalled,
  AuditEventType.KycRevocationReceived,
  AuditEventType.RiskQuestionnaireComplete,
  AuditEventType.ScopedSessionMinted,
  AuditEventType.ScopedSessionRevoked,
  AuditEventType.ScopedSessionExpired,
  AuditEventType.ScopedSessionRevokedByPolicyMigration,
] as const;
