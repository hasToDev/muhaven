import type {
  ScopedSession,
  ScopedSessionInstallMaterial,
} from '../model/scoped-session.js';
import type { Surface } from '../model/surface.enum.js';

/**
 * Wave 5 Option D · Commit 2 — install-material write payload. The
 * mint use-case passes cleartext to the repo; the Pg repo's `create`
 * wraps both `enableData` and `enableSig` in `pgp_sym_encrypt(...)`
 * before INSERT. `null` skips the column (NULL-first default).
 */
export interface ScopedSessionInstallMaterialWrite {
  readonly enableData: `0x${string}` | null;
  readonly enableSig: `0x${string}` | null;
  readonly validatorNonce: number | null;
}

/**
 * Repository interface for `agent_scoped_sessions` (Wave 5 Path D
 * Slice 2 Commit 2.A · RD-3). Read-only mirror of the broker keystore;
 * see `ScopedSession` JSDoc for the read/write boundary.
 *
 * Method shapes are intentionally narrow — the broker daemon owns the
 * enforcement queries (decode innerCall, decode cap arg index). Backend
 * mirror queries are dashboard-facing ("show me the active session")
 * or MCP-facing ("give me the active snapshot so I can install it").
 */
export interface IScopedSessionRepository {
  /**
   * INSERT. Throws on PK conflict (`sessionId` already exists). Caller
   * (`MintScopedSessionUseCase`) is responsible for the active-dedup
   * check via `findLatestActive` before calling this — the DB-level
   * conflict catches the race that the in-memory check missed.
   *
   * `installMaterial` (Wave 5 Option D · Commit 2) carries the optional
   * `enableData` + `enableSig` + `validatorNonce` captured at mint time
   * by the frontend. The Pg implementation encrypts the first two via
   * `pgp_sym_encrypt(...)` before INSERT; memory implementation stores
   * them verbatim. `null` fields skip the column write (NULL-first
   * default). `enableStatus` is set to `'pending'` by the implementation
   * when ANY install material field is non-null, else NULL.
   */
  create(
    session: ScopedSession,
    installMaterial?: ScopedSessionInstallMaterialWrite,
  ): Promise<void>;

  /**
   * Wave 5 Option D · Commit 2 — fetch the encrypted install material
   * for a session, decrypted at the SQL layer via pgcrypto. Returns
   * `null` when the session does not exist OR when the user does not
   * own it (caller passes `userId` for the ownership check; defense-
   * in-depth on top of the route-layer service-secret gate).
   *
   * Surfaces ONLY through the install-material subroute; the default
   * scoped-session reads continue to redact enable_data / enable_sig.
   * Throws `MissingEncryptionKeyError` from `pgcrypto.ts` when the
   * `OPTION_D_C2_ENCRYPTION_KEY` env var is unset — the route maps
   * that to a 503.
   */
  findInstallMaterialById(
    sessionId: string,
    userId: string,
  ): Promise<ScopedSessionInstallMaterial | null>;

  /**
   * Lookup by primary key. Returns `null` if absent. Does NOT filter on
   * status or expiry — callers wanting an active session use
   * `findLatestActive` instead. Used by `RevokeScopedSessionUseCase` to
   * load + ownership-verify before flipping status.
   */
  findById(sessionId: string): Promise<ScopedSession | null>;

  /**
   * Returns the most-recently-minted active snapshot for
   * `(userId, surface)` whose `validUntilSec > nowSec`. Returns `null`
   * if zero rows match. Backs:
   *
   *  - Dashboard banner read (Commit 2.C).
   *  - MCP auto-sync (Commit 2.B).
   *  - `MintScopedSessionUseCase` pre-insert dedup check.
   *
   * The partial lookup index `agent_scoped_sessions_lookup_active_v1`
   * (and the sibling partial UNIQUE `_user_surface_active_uq_v2`) keep
   * this point-query cheap regardless of historical row count.
   */
  findLatestActive(
    userId: string,
    surface: Surface,
    nowSec: number,
  ): Promise<ScopedSession | null>;

  /**
   * Wave 5 Option D · C5 (Telegram `/revoke_session` kill-switch) —
   * surface-AGNOSTIC active lookup. Returns EVERY active session for
   * `userId` whose `validUntilSec > nowSec`, across all surfaces (mcp,
   * havenbot, openclaw, checkout). Distinct from `findLatestActive`,
   * which returns the single most-recent active row for ONE
   * `(userId, surface)` pair.
   *
   * The Telegram phone kill-switch must kill autonomous trading on
   * EVERY surface at once — "stop everything" — not just the `mcp`
   * surface the dashboard hard-locks scoped sessions under today. If a
   * future surface ever mints a scoped session, an explicit user
   * kill-switch must still reach it; keying the revoke to one surface
   * would silently leave such a session live.
   *
   * Orphaned rows (`userId IS NULL` after the CASCADE SET NULL on user
   * deletion) are excluded by the `userId` equality predicate — NULL
   * never equals a string in SQL. Returns an empty array when none
   * match (the use-case layer maps empty → 409 "nothing to revoke").
   * Order is deterministic (surface, then sessionId) so the use-case's
   * revoke loop and the integration tests see a stable sequence.
   */
  findActiveByUser(userId: string, nowSec: number): Promise<ScopedSession[]>;

  /**
   * Mark `sessionId` as `status='revoked'` with `revokedAt = now`.
   * Returns the revoked entity, OR `null` if:
   *   - row not found, OR
   *   - row already terminal (`status != 'active'`).
   *
   * The use-case layer maps null → 404 / 409 based on the prior check.
   * Idempotent on terminal rows (no double-revoke audit emission in
   * Commit 2.B).
   */
  revoke(sessionId: string, now: Date): Promise<ScopedSession | null>;

  /**
   * Bulk-flip `status='active'` rows whose `validUntilSec <= beforeSec`
   * to `'expired'` with `expiredAt = now`. Returns the count of rows
   * flipped. Driven by a future expiry-sweep cron (not in Commit 2.A;
   * Slice 5+); shipped on the interface now so the cron can land without
   * widening this surface later.
   *
   * **Caution**: this method touches EVERY active-and-expired row in the
   * table. Per-request hot-path callers should prefer
   * `markExpiredForUserSurface` (per-user predicate) to avoid the
   * cross-user write-amplification on every mint. R2 Software Architect
   * H-2 round 1.
   */
  markExpired(beforeSec: number, now: Date): Promise<number>;

  /**
   * Per-user variant of `markExpired` — flips `status='active'` rows
   * to `'expired'` ONLY for `(userId, surface)`. Used by
   * `MintScopedSessionUseCase` step 2a as the opportunistic sweep that
   * frees the partial-UNIQUE slot before the optimistic dedup check.
   *
   * Returns the count of rows flipped. The partial active-index +
   * (user, surface) predicate makes this O(0) or O(1) per call —
   * exactly one row maximum per user/surface in the active state per
   * the partial UNIQUE constraint.
   *
   * R2 Software Architect H-2 round 1 — narrowed from the bulk variant
   * to eliminate cross-user write amplification on the mint hot path.
   * Bulk `markExpired` stays for the future expiry-sweep cron.
   */
  markExpiredForUserSurface(
    userId: string,
    surface: Surface,
    beforeSec: number,
    now: Date,
  ): Promise<number>;

  /**
   * Wave 5 Option D · Commit 1 — one-shot bulk revoke. Flips EVERY
   * `status='active'` row (regardless of `valid_until_sec`) to
   * `'revoked'` with `revoked_at = now`, returning the affected
   * domain entities so the migration use-case can emit one audit
   * row per affected session.
   *
   * Distinct from `markExpired` (which targets time-expired actives)
   * AND from `revoke(sessionId, ...)` (per-row, user-driven). This
   * variant exists solely for the migration use-case
   * `RevokeAllPreOptionDScopedSessionsUseCase`. Idempotent — re-run
   * on an empty active set returns an empty array.
   *
   * **Includes CASCADE-orphaned rows.** Rows whose `userId` is NULL
   * (FK `onDelete:'set null'` after user deletion — see
   * `schema.ts::agentScopedSessions.userId` for the schema invariant)
   * ARE returned to the caller. The use-case layer is responsible
   * for handling them (audit emission requires a userId, so they're
   * surfaced via a separate `skippedOrphanedUserIds` field on the
   * result). This cross-layer invariant is load-bearing — a future
   * repo-side "filter rows with userId IS NOT NULL" optimisation
   * would silently strip orphan flips from the use-case's accounting
   * (BA-HIGH-4, multi-agent review 2026-05-23).
   *
   * **Caution**: touches every active row in the table. Reserved for
   * operator-driven one-shot scripts; per-request callers MUST NOT
   * use this method.
   */
  revokeAllActive(now: Date): Promise<ScopedSession[]>;

  /**
   * Wave 5 Option D · Commit 3 — lookup the mirror row whose
   * (`permission_id`, `signer_address`) pair matches a `PermissionInstalled`
   * event observed on-chain.
   *
   * **NOTE**: kernel V3.1's `PermissionInstalled(bytes4 permission,
   * uint32 nonce)` event has NEITHER the account address NOR the signer
   * indexed — both are emitted by the kernel that owns the validator,
   * so the matching is done by:
   *   - `event.address` (the kernel address that emitted the log) ==
   *     `agent_scoped_sessions.signer_address`'s OWNING kernel
   *
   * Because we DON'T have the kernel<->signer mapping at the SQL layer
   * (signers are session-key EOAs, kernels are smart accounts), the
   * preferred lookup is `(permissionId, accountAddress)` where
   * `accountAddress` is the emitter address from the receipt.
   *
   * Returns `null` when zero match (callback / indexer skips the
   * receipt — defense against PermissionInstalled events for permissions
   * we never minted). Returns the most-recent row when 2+ match (a
   * permissionId collision under a re-mint window; the latest row is
   * the one to flip).
   */
  findByPermissionIdAndAccountAddress(
    permissionId: `0x${string}`,
    accountAddress: `0x${string}`,
  ): Promise<ScopedSession | null>;

  /**
   * Wave 5 Option D · Commit 3 — flip a row from `enable_status='pending'`
   * to `'enabled'`, atomically setting `validator_enabled_at = now` and
   * `validator_enabled_tx_hash = txHash`.
   *
   * Idempotent: when the row's `enable_status` is already `'enabled'`,
   * returns the existing row unchanged (the chain indexer + broker
   * callback path may race; whichever wins is the source-of-truth, the
   * loser is a no-op). Returns `null` when the row was never in
   * `'pending'` to begin with (defense against a `'failed'` re-flip).
   *
   * The DB CHECK constraint enforces that `validator_enabled_at IS NULL
   * ⇔ enable_status != 'enabled'` — the implementation MUST keep both
   * columns in lockstep.
   */
  markValidatorEnabled(
    sessionId: string,
    txHash: `0x${string}`,
    now: Date,
  ): Promise<ScopedSession | null>;

  /**
   * Wave 5 Option D · Commit 3 — flip a row from `enable_status='pending'`
   * to `'failed'`. Used by the 60-block watchdog cron when the
   * `PermissionInstalled` event never lands.
   *
   * Idempotent on already-failed rows. Returns `null` when the row was
   * already `'enabled'` (no re-flip; chain wins).
   *
   * Does NOT touch `validator_enabled_at` / `validator_enabled_tx_hash`
   * — both stay NULL per the CHECK constraint.
   */
  markValidatorFailed(sessionId: string): Promise<ScopedSession | null>;

  /**
   * Wave 5 Slice 2 (auto-reinvest) — flip the `reinvest_enabled` opt-in
   * on the user's ACTIVE session for `(userId, surface)`. Returns the
   * updated row, or `null` when there is no active session to toggle.
   * Idempotent (setting to the same value re-returns the row). The
   * frontend Autonomy toggle drives this; the `should-run` gate reads it.
   */
  setReinvestEnabled(
    userId: string,
    surface: Surface,
    enabled: boolean,
    now: Date,
  ): Promise<ScopedSession | null>;

  /**
   * Wave 5 Option D · Commit 3 (trigger corrected in the third commit)
   * — fetch active rows whose `enable_status='pending'` AND
   * `valid_until_sec <= cutoffSec` (the session's TTL window has
   * closed without the validator ever being installed).
   *
   * **Why TTL-based, not mint-age-based**: C3 installs the validator
   * at the user's FIRST Path D buy (MODE.ENABLE), which can land
   * arbitrarily long after mint (a user legitimately takes minutes-to-
   * hours to configure their broker + buy). The original
   * `findPendingEnableOlderThan(mintedAt)` flagged healthy within-TTL
   * pending sessions as `failed` prematurely — surfaced organically
   * at the first prod smoke when a fresh session was killed ~12min
   * after mint, before the user's first buy. A pending session is
   * only genuinely "failed" once its TTL expires without installing;
   * within TTL it's retryable and must be left alone.
   *
   * Caller (watchdog) passes `cutoffSec = nowSec - graceSec` where
   * `graceSec` is a small post-expiry buffer (`VALIDATOR_ENABLE_WATCHDOG_STALE_SEC`,
   * repurposed). Returns at most `limit` rows, oldest-`valid_until_sec`
   * first.
   */
  findExpiredPendingEnable(
    cutoffSec: number,
    limit: number,
  ): Promise<ScopedSession[]>;
}
