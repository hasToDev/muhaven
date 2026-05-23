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
}
