import { and, desc, eq, gt, lte } from 'drizzle-orm';
import { ScopedSession, type ScopedSelectorCap } from '../../../domain/agent/model/scoped-session.js';
import {
  ScopedSessionStatus,
  isScopedSessionStatus,
} from '../../../domain/agent/model/scoped-session-status.enum.js';
import type { Surface } from '../../../domain/agent/model/surface.enum.js';
import type { IScopedSessionRepository } from '../../../domain/agent/repository/scoped-session.repository.js';
import { agentScopedSessions } from './schema.js';
import type { Db } from './db.js';

/**
 * Wave 5 Path D Slice 2 Commit 2.A — Postgres scoped-session mirror
 * repository. Storage of broker-keystore policy snapshots; see
 * `ScopedSession` JSDoc for the read/write boundary + the privacy
 * invariant (no cleartext FHE values).
 *
 * **Numeric storage**:
 *  - `max_per_op_usd6` / `total_spent_usd6` are `numeric(78,0)`. node-
 *    postgres returns numeric as strings to preserve precision past
 *    2^53; `BigInt(string)` is the safe round-trip and the domain
 *    field type matches (`bigint`).
 *  - `valid_until_sec` / `minted_at_sec` are `bigint` (int8) via
 *    Drizzle's `mode: 'number'`. node-postgres returns int8 as a
 *    string by default; `mode: 'number'` runs `Number(...)` on read,
 *    which is safe because the Zod write gate caps both at
 *    `Number.MAX_SAFE_INTEGER` (≈ year 287_396_259) so no precision
 *    loss occurs across the round-trip.
 *
 * **JSON columns**: `target_contracts` / `selector_caps` round-trip
 * verbatim via jsonb. Caller is responsible for the hex shape (use-case
 * lowercases at mint time; this layer trusts the stored value).
 */
export class PgScopedSessionRepository implements IScopedSessionRepository {
  constructor(private readonly db: Db) {}

  async create(session: ScopedSession): Promise<void> {
    await this.db.insert(agentScopedSessions).values({
      sessionId: session.sessionId,
      userId: session.userId,
      surface: session.surface,
      status: session.status,
      signerAddress: session.signerAddress,
      permissionId: session.permissionId,
      // jsonb expects mutable arrays — strip readonly via spread copy.
      targetContracts: [...session.targetContracts] as string[],
      selectorCaps: session.selectorCaps.map((c) => ({
        selector: c.selector,
        capArgIndex: c.capArgIndex,
        maxAmount: c.maxAmount,
      })),
      maxPerOpUsd6: session.maxPerOpUsd6.toString(),
      totalSpentUsd6: session.totalSpentUsd6.toString(),
      // bigint columns: Drizzle `mode: 'number'` accepts JS numbers
      // directly; the schema-side `bigint` is int8 fixed-width.
      validUntilSec: session.validUntilSec,
      mintedAtSec: session.mintedAtSec,
      consentActionHash: session.consentActionHash,
      consentTextSha256: session.consentTextSha256,
      mintedAt: session.mintedAt,
      revokedAt: session.revokedAt,
      expiredAt: session.expiredAt,
    });
  }

  async findById(sessionId: string): Promise<ScopedSession | null> {
    const row = await this.db.query.agentScopedSessions.findFirst({
      where: eq(agentScopedSessions.sessionId, sessionId),
    });
    return row ? this.toDomain(row) : null;
  }

  async findLatestActive(
    userId: string,
    surface: Surface,
    nowSec: number,
  ): Promise<ScopedSession | null> {
    // Index `agent_scoped_sessions_user_surface_active_uq_v1` covers the
    // (user_id, surface, valid_until_sec, minted_at DESC) WHERE
    // status='active' shape exactly. Newest `mintedAt` first; PK tiebreak
    // for determinism when two rows share `mintedAt` ms (rare; partial
    // UNIQUE guarantees at most one row in practice, but the tiebreak
    // hardens the test against degenerate rows seeded out-of-band).
    // Note: orphaned rows (userId === NULL after CASCADE SET NULL) are
    // automatically excluded by the `eq(userId, $)` predicate — NULL
    // never equals a string value in SQL.
    const row = await this.db.query.agentScopedSessions.findFirst({
      where: and(
        eq(agentScopedSessions.userId, userId),
        eq(agentScopedSessions.surface, surface),
        eq(agentScopedSessions.status, ScopedSessionStatus.Active),
        gt(agentScopedSessions.validUntilSec, nowSec),
      ),
      orderBy: [desc(agentScopedSessions.mintedAt), agentScopedSessions.sessionId],
    });
    return row ? this.toDomain(row) : null;
  }

  async revoke(sessionId: string, now: Date): Promise<ScopedSession | null> {
    // Conditional UPDATE — only flips an active row; concurrent
    // revoke-revoke / revoke-expire races resolve at the WHERE clause
    // (one wins, the other returns no rows → null). RETURNING captures
    // the post-update value in one round trip.
    const rows = await this.db
      .update(agentScopedSessions)
      .set({
        status: ScopedSessionStatus.Revoked,
        revokedAt: now,
      })
      .where(
        and(
          eq(agentScopedSessions.sessionId, sessionId),
          eq(agentScopedSessions.status, ScopedSessionStatus.Active),
        ),
      )
      .returning();
    const row = rows[0];
    return row ? this.toDomain(row) : null;
  }

  async markExpired(beforeSec: number, now: Date): Promise<number> {
    const rows = await this.db
      .update(agentScopedSessions)
      .set({
        status: ScopedSessionStatus.Expired,
        expiredAt: now,
      })
      .where(
        and(
          eq(agentScopedSessions.status, ScopedSessionStatus.Active),
          lte(agentScopedSessions.validUntilSec, beforeSec),
        ),
      )
      .returning({ sessionId: agentScopedSessions.sessionId });
    return rows.length;
  }

  private toDomain(row: typeof agentScopedSessions.$inferSelect): ScopedSession {
    // Defense-in-depth at the read boundary. Scalar columns are gated by
    // schema CHECK constraints (`schema.ts:agent_scoped_sessions_*_chk`)
    // + Drizzle enum types; mismatch at insert time is impossible
    // through the SQL layer. The jsonb columns (`target_contracts`,
    // `selector_caps`) have NO inner-shape CHECK — Postgres `jsonb`
    // accepts arbitrary JSON, and the use-case layer is the sole gate on
    // sub-field types. A future hand-INSERT bypassing the use-case (or
    // a Slice 5+ history-table migration that backfills jsonb shapes)
    // could land malformed inner structures.
    //
    // The runtime guards below catch the OUTER-shape disaster (non-array
    // jsonb) so a downstream `.map(...)` crashes with a clear "malformed
    // row" message instead of an opaque TypeError deep in handler code.
    // INNER-shape validation is NOT performed here — the cost of running
    // Zod on every row-read across the hot path was not justified for
    // Slice 1's threat model. Adversary surface = operator with DB
    // access; mitigation = the use-case path stays the only write path,
    // and pgaudit (or `log_statement = 'mod'`) captures any out-of-band
    // writes server-side. Re-evaluate at Slice 5 if a history-table or
    // bulk-migration path appears.
    if (!isScopedSessionStatus(row.status)) {
      throw new Error(
        `pg-scoped-session: row ${row.sessionId} has invalid status ${row.status}`,
      );
    }
    if (!Array.isArray(row.targetContracts)) {
      throw new Error(
        `pg-scoped-session: row ${row.sessionId} target_contracts is not an array`,
      );
    }
    if (!Array.isArray(row.selectorCaps)) {
      throw new Error(
        `pg-scoped-session: row ${row.sessionId} selector_caps is not an array`,
      );
    }
    return new ScopedSession({
      sessionId: row.sessionId,
      userId: row.userId, // nullable since 2026-05-22: FK onDelete:'set null'
      surface: row.surface as Surface,
      status: row.status,
      signerAddress: row.signerAddress as `0x${string}`,
      permissionId: (row.permissionId as `0x${string}` | null) ?? null,
      targetContracts: (row.targetContracts as string[]).map(
        (a) => a as `0x${string}`,
      ),
      selectorCaps: (row.selectorCaps as ScopedSelectorCap[]).map((c) => ({
        selector: c.selector,
        capArgIndex: c.capArgIndex,
        maxAmount: c.maxAmount,
      })),
      maxPerOpUsd6: BigInt(row.maxPerOpUsd6),
      totalSpentUsd6: BigInt(row.totalSpentUsd6),
      // bigint columns: Drizzle returns numbers directly with `mode:
      // 'number'`. The schema is int8 (8 bytes fixed) so this is
      // register-comparable + no String→bigint→Number round-trip risk.
      validUntilSec: row.validUntilSec,
      mintedAtSec: row.mintedAtSec,
      consentActionHash: (row.consentActionHash as `0x${string}` | null) ?? null,
      consentTextSha256: (row.consentTextSha256 as `0x${string}` | null) ?? null,
      mintedAt: row.mintedAt,
      revokedAt: row.revokedAt ?? null,
      expiredAt: row.expiredAt ?? null,
    });
  }
}
