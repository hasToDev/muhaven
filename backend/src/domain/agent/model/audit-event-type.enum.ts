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
  /**
   * Wave 5 Option D Commit 3 — emitted by `ValidatorEnableWatchdog`
   * when a pending Scoped session crossed the stale threshold without
   * a `PermissionInstalled` event arriving. Sibling to
   * `ValidatorInstalled`; ensures the forensic audit chain has both
   * sides of the install lifecycle. Symmetric audit emission was a
   * multi-agent review (SW Arch M-4) catch — previously the watchdog
   * flipped rows to `'failed'` via the repo directly, leaving the
   * audit table one-sided (success-only).
   */
  ValidatorInstallFailed: 'validator_install_failed',
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
  /**
   * Wave 5 Slice 1 (MCP sell) — emitted ONCE per legacy Scoped session the
   * first time the GET-mirror read derives the redeem + queue-submit
   * selectorCaps (+ per-token queue targets) for it.
   *
   * Provenance marker for the LOCKED #1 audit caveat: those sell caps are
   * **platform-derived from the pre-authorized on-chain Scoped CallPolicy
   * envelope** (the D-1 broadening already authorized redeem + queue
   * submit/claim at mint), NOT a fresh per-redeem user consent. The original
   * mint's consent copy was buy-framed; this row records that the platform
   * extended the broker's signable selector set to the sell ops the on-chain
   * envelope already permitted. NEW mints carry these caps natively (frontend
   * `buildScopedMintBody`), so this only fires for pre-Slice-1 rows.
   *
   * MUST stay in lockstep with the `agent_audit_event_type` pgEnum
   * (`schema.ts`) — adding here without the pgEnum value makes the audit
   * INSERT throw `invalid input value for enum`. See the
   * `ValidatorInstallFailed` drift note above.
   */
  ScopedSessionSellCapsDerived: 'scoped_session_sell_caps_derived',
  /**
   * Wave 5 Slice 2c (auto-reinvest runner) — emitted once per executed
   * reinvest cycle by the keyless `muhaven-reinvest` runner after it
   * atomically claims a matured epoch and buys more of the same RWA in a
   * single UserOp. Correlates the claim + buy legs (one `executeBatch`
   * UserOp → one txHash) by `reinvest_cycle_id`; deduped per `(user,
   * epoch)` so a slow-settling UserOp re-surfaced by the gate before its
   * receipt lands isn't double-recorded. The metadata is cleartext-by-
   * design (epochId, token, snapshot, userOpHash, txHash, buyShares,
   * budgetUsd6) — the claimed AMOUNT stays encrypted (amount-blind), so
   * NO decrypted-FHE primitive ever enters this row.
   *
   * MUST stay in lockstep with the `agent_audit_event_type` pgEnum
   * (`schema.ts`) — see the `validator_install_failed` drift note above;
   * operator `db:push` applies the ALTER TYPE...ADD VALUE before the
   * first emit.
   */
  ReinvestCycleExecuted: 'reinvest_cycle_executed',
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
  AuditEventType.ValidatorInstallFailed,
  AuditEventType.KycRevocationReceived,
  AuditEventType.RiskQuestionnaireComplete,
  AuditEventType.ScopedSessionMinted,
  AuditEventType.ScopedSessionRevoked,
  AuditEventType.ScopedSessionExpired,
  AuditEventType.ScopedSessionRevokedByPolicyMigration,
  AuditEventType.ScopedSessionSellCapsDerived,
  AuditEventType.ReinvestCycleExecuted,
] as const;
