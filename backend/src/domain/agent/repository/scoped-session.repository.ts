import type { ScopedSession } from '../model/scoped-session.js';
import type { Surface } from '../model/surface.enum.js';

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
   */
  create(session: ScopedSession): Promise<void>;

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
   */
  markExpired(beforeSec: number, now: Date): Promise<number>;
}
