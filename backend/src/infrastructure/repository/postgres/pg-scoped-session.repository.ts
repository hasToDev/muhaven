import { and, asc, desc, eq, gt, lt, lte, sql } from 'drizzle-orm';
import {
  ScopedSession,
  isScopedSessionEnableStatus,
  type ScopedSelectorCap,
  type ScopedSessionEnableStatus,
  type ScopedSessionInstallMaterial,
} from '../../../domain/agent/model/scoped-session.js';
import {
  ScopedSessionStatus,
  isScopedSessionStatus,
} from '../../../domain/agent/model/scoped-session-status.enum.js';
import type { Surface } from '../../../domain/agent/model/surface.enum.js';
import type {
  IScopedSessionRepository,
  ScopedSessionInstallMaterialWrite,
} from '../../../domain/agent/repository/scoped-session.repository.js';
import { agentScopedSessions } from './schema.js';
import type { Db } from './db.js';
import { encryptedTextOrNull, requireEncryptionKey } from './pgcrypto.js';

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

  async create(
    session: ScopedSession,
    installMaterial?: ScopedSessionInstallMaterialWrite,
  ): Promise<void> {
    // Wave 5 Option D · Commit 2 — encrypt enableData / enableSig via
    // pgcrypto. `encryptedTextOrNull` returns a `pgp_sym_encrypt(...)`
    // SQL fragment Drizzle interpolates as a column value; `null`
    // input → `null` output (column stays NULL).
    //
    // The cast through `unknown` then to the column type is necessary
    // because Drizzle's `.values()` type doesn't model SQL-fragment
    // values for bytea columns out of the box; the runtime path is
    // standard parameter binding via the `sql` template tag.
    //
    // `enableStatus` + `validatorNonce` are NOT derived here — the
    // use-case (`MintScopedSessionUseCase`) already populates them
    // on `session` based on the install-material presence. The repo
    // stays a thin persistence boundary.
    // Explicit null check rather than truthiness — defends against a
    // future DTO change that accepts `'0x'` (currently rejected by
    // Zod) silently bypassing encryption. Multi-agent review CR H-2.
    const enableDataValue =
      installMaterial?.enableData != null
        ? encryptedTextOrNull(installMaterial.enableData)
        : null;
    const enableSigValue =
      installMaterial?.enableSig != null
        ? encryptedTextOrNull(installMaterial.enableSig)
        : null;
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
      // Wave 5 Option D · Commit 2 install-material columns.
      enableData: enableDataValue as unknown as Buffer | null,
      enableSig: enableSigValue as unknown as Buffer | null,
      validatorNonce: session.validatorNonce,
      enableStatus: session.enableStatus,
      validatorEnabledAt: session.validatorEnabledAt,
      validatorEnabledTxHash: session.validatorEnabledTxHash,
    });
  }

  async findById(sessionId: string): Promise<ScopedSession | null> {
    // Wave 5 Option D · Commit 2 — explicit `columns: { ... }` exclusion
    // of the pgcrypto-encrypted blobs. Drizzle's `false` entries are
    // EXCLUSION filters when other columns are unspecified — every
    // remaining column is included by default. Two-pronged defense:
    // (a) keeps the encrypted bytea out of the default response so a
    // maintainer can't accidentally surface it through a `findFirst`
    // refactor, (b) reduces the per-row payload (the encrypted blob
    // can be 1-2KB).
    const row = await this.db.query.agentScopedSessions.findFirst({
      where: eq(agentScopedSessions.sessionId, sessionId),
      columns: { enableData: false, enableSig: false },
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
      // Wave 5 Option D · Commit 2 — see `findById` JSDoc for the
      // rationale on the exclusion filter.
      columns: { enableData: false, enableSig: false },
    });
    return row ? this.toDomain(row) : null;
  }

  async findInstallMaterialById(
    sessionId: string,
    userId: string,
  ): Promise<ScopedSessionInstallMaterial | null> {
    // Wave 5 Option D · Commit 2 — install-material read path. Uses
    // a raw SELECT so we can compose `pgp_sym_decrypt(...)` directly
    // in the projection (Drizzle's relational API doesn't easily
    // model derived columns).
    //
    // Defense-in-depth ownership check: the route-layer service-secret
    // gate proves the CALLER is the MCP server, not who the row
    // belongs to. We re-check `user_id = ${userId}` here so a
    // service-secret holder can't peek at OTHER users' install
    // material by varying the sessionId.
    //
    // `MissingEncryptionKeyError` from `requireEncryptionKey` propagates
    // — the route maps it to 503.
    const key = requireEncryptionKey();
    const result = await this.db.execute(sql<{
      session_id: string;
      user_id: string | null;
      surface: string;
      status: string;
      signer_address: string;
      permission_id: string | null;
      enable_status: string | null;
      enable_data_cleartext: string | null;
      enable_sig_cleartext: string | null;
      validator_nonce: number | null;
      validator_enabled_at: Date | null;
      validator_enabled_tx_hash: string | null;
      valid_until_sec: number;
      minted_at_sec: number;
    }>`
      SELECT
        session_id,
        user_id,
        surface,
        status,
        signer_address,
        permission_id,
        enable_status,
        CASE
          WHEN enable_data IS NULL THEN NULL
          ELSE pgp_sym_decrypt(enable_data, ${key}::text)::text
        END AS enable_data_cleartext,
        CASE
          WHEN enable_sig IS NULL THEN NULL
          ELSE pgp_sym_decrypt(enable_sig, ${key}::text)::text
        END AS enable_sig_cleartext,
        validator_nonce,
        validator_enabled_at,
        validator_enabled_tx_hash,
        valid_until_sec,
        minted_at_sec
      FROM agent_scoped_sessions
      WHERE session_id = ${sessionId}
        AND user_id = ${userId}
      LIMIT 1
    `);
    const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
    if (!rows || rows.length === 0) return null;
    const row = rows[0]!;
    if (!isScopedSessionStatus(row.status)) {
      throw new Error(
        `pg-scoped-session: install-material row ${row.session_id} has invalid status ${row.status}`,
      );
    }
    const enableStatus = row.enable_status;
    if (enableStatus !== null && !isScopedSessionEnableStatus(enableStatus)) {
      throw new Error(
        `pg-scoped-session: install-material row ${row.session_id} has invalid enable_status ${enableStatus}`,
      );
    }
    return {
      sessionId: row.session_id as string,
      userId: (row.user_id as string | null) ?? null,
      surface: row.surface as Surface,
      status: row.status,
      signerAddress: row.signer_address as `0x${string}`,
      permissionId: (row.permission_id as `0x${string}` | null) ?? null,
      enableStatus: enableStatus as ScopedSessionEnableStatus | null,
      enableData: (row.enable_data_cleartext as `0x${string}` | null) ?? null,
      enableSig: (row.enable_sig_cleartext as `0x${string}` | null) ?? null,
      validatorNonce:
        row.validator_nonce === null || row.validator_nonce === undefined
          ? null
          : Number(row.validator_nonce),
      validatorEnabledAt: (row.validator_enabled_at as Date | null) ?? null,
      validatorEnabledTxHash:
        (row.validator_enabled_tx_hash as `0x${string}` | null) ?? null,
      validUntilSec: Number(row.valid_until_sec),
      mintedAtSec: Number(row.minted_at_sec),
    };
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

  async revokeAllActive(now: Date): Promise<ScopedSession[]> {
    // Wave 5 Option D · Commit 1 — bulk-flip every active row,
    // returning the full row payload so the use-case can emit one
    // `ScopedSessionRevokedByPolicyMigration` audit row per affected
    // session with stable forensic anchors (userId, surface,
    // signerAddress, permissionId).
    //
    // Single statement with RETURNING * — atomic per-row, no race
    // with concurrent per-row revokes (those land on `status='active'`
    // too, so the WHERE clause naturally orders any concurrent
    // user-driven revoke before/after this bulk update).
    const rows = await this.db
      .update(agentScopedSessions)
      .set({
        status: ScopedSessionStatus.Revoked,
        revokedAt: now,
      })
      .where(eq(agentScopedSessions.status, ScopedSessionStatus.Active))
      .returning();
    return rows.map((row) => this.toDomain(row));
  }

  // ── Wave 5 Option D · Commit 3 — PermissionValidator install lifecycle ──

  async findByPermissionIdAndAccountAddress(
    permissionId: `0x${string}`,
    accountAddress: `0x${string}`,
  ): Promise<ScopedSession | null> {
    // Chain indexer + broker-callback both call this. The match-key is
    // `(permission_id, account_address)` where `account_address` is the
    // KERNEL that emitted the `PermissionInstalled` log. The mirror's
    // `signer_address` is the SESSION-KEY EOA — those are distinct (a
    // single kernel has multiple session keys over time). We therefore
    // cannot match on `signer_address`; we match on `permission_id`
    // alone + return `null` when a clash lands across two kernels in
    // the same observation window (multi-agent review HIGH-1 across
    // CR + BE Arch + SecEng all flagged this collision risk).
    //
    // **Cross-user collision defense**: permissionId is
    // `keccak256(policy+signer).slice(0,4)` — 4 bytes = ~4.3B space.
    // A clash is improbable but possible. When two active rows share
    // a permissionId, we refuse to flip either — the operator triages
    // out-of-band. The chain indexer logs the clash + skips; the
    // callback returns 409 to the broker which exhausts its retry
    // budget (then a future operator-side reconciliation tool
    // resolves it).
    //
    // **Future schema growth**: once `agent_scoped_sessions` has an
    // `account_address` column, this lookup will filter on it AND on
    // `permission_id`, eliminating the clash refusal entirely. The
    // `accountAddress` parameter is preserved for that future binding;
    // for now we use it for the multi-match defense by re-running the
    // query and refusing on >1 hit.
    void accountAddress;
    const rows = await this.db.query.agentScopedSessions.findMany({
      where: eq(agentScopedSessions.permissionId, permissionId.toLowerCase() as `0x${string}`),
      orderBy: [desc(agentScopedSessions.mintedAt), agentScopedSessions.sessionId],
      columns: { enableData: false, enableSig: false },
      limit: 2,
    });
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      // Multi-match — refuse to flip rather than silently pick one.
      // The caller's log channel surfaces this; an operator alert is
      // raised at the indexer log level (callers MUST NOT swallow).
      // Returning null forces the caller through its terminal-error
      // path (chain indexer: skip + log; route: 404 from use-case).
      throw new Error(
        `permissionId collision: ${rows.length}+ rows match permissionId=${permissionId.toLowerCase()} (sessionIds=${rows
          .map((r) => r.sessionId)
          .join(',')}); refusing to flip — operator triage required`,
      );
    }
    return this.toDomain(rows[0]!);
  }

  async markValidatorEnabled(
    sessionId: string,
    txHash: `0x${string}`,
    now: Date,
  ): Promise<ScopedSession | null> {
    // Idempotent flip: WHERE clause requires `enable_status='pending'`
    // so concurrent racers (chain indexer vs broker callback) resolve
    // at the predicate — one updates, the other returns no rows.
    //
    // CHECK `(validator_enabled_at IS NULL) = (enable_status IS NULL OR
    // enable_status != 'enabled')` enforces the column-pair invariant.
    const rows = await this.db
      .update(agentScopedSessions)
      .set({
        enableStatus: 'enabled',
        validatorEnabledAt: now,
        validatorEnabledTxHash: txHash.toLowerCase() as `0x${string}`,
      })
      .where(
        and(
          eq(agentScopedSessions.sessionId, sessionId),
          eq(agentScopedSessions.enableStatus, 'pending'),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) {
      // Idempotent fallback: when the row was already `enabled` (race
      // winner already flipped it), return the existing row so the
      // caller can emit a no-op response.
      return this.findById(sessionId);
    }
    return this.toDomain(row);
  }

  async markValidatorFailed(
    sessionId: string,
  ): Promise<ScopedSession | null> {
    const rows = await this.db
      .update(agentScopedSessions)
      .set({ enableStatus: 'failed' })
      .where(
        and(
          eq(agentScopedSessions.sessionId, sessionId),
          eq(agentScopedSessions.enableStatus, 'pending'),
        ),
      )
      .returning();
    const row = rows[0];
    return row ? this.toDomain(row) : null;
  }

  async findPendingEnableOlderThan(
    beforeDate: Date,
    limit: number,
  ): Promise<ScopedSession[]> {
    // Partial index `agent_scoped_sessions_pending_enable_v1 ON
    // (minted_at) WHERE enable_status='pending' AND status='active'`
    // covers this seek exactly. Order ASC by mintedAt so the watchdog
    // processes the oldest-stuck rows first (FIFO operator triage).
    const rows = await this.db.query.agentScopedSessions.findMany({
      where: and(
        eq(agentScopedSessions.status, ScopedSessionStatus.Active),
        eq(agentScopedSessions.enableStatus, 'pending'),
        lt(agentScopedSessions.mintedAt, beforeDate),
      ),
      orderBy: [asc(agentScopedSessions.mintedAt), agentScopedSessions.sessionId],
      limit,
      columns: { enableData: false, enableSig: false },
    });
    return rows.map((r) => this.toDomain(r));
  }

  async markExpiredForUserSurface(
    userId: string,
    surface: Surface,
    beforeSec: number,
    now: Date,
  ): Promise<number> {
    // Per-user narrow — uses the partial active-index
    // `agent_scoped_sessions_user_surface_active_uq_v2` for the
    // (user_id, surface, status='active') seek. At most one row in the
    // active state per (user, surface) per the partial UNIQUE, so the
    // index scan returns ≤1 row, the UPDATE locks ≤1 row, and the
    // cross-user write amplification of the bulk variant is eliminated
    // on the mint hot path. R2 Software Architect H-2 round 1.
    const rows = await this.db
      .update(agentScopedSessions)
      .set({
        status: ScopedSessionStatus.Expired,
        expiredAt: now,
      })
      .where(
        and(
          eq(agentScopedSessions.userId, userId),
          eq(agentScopedSessions.surface, surface),
          eq(agentScopedSessions.status, ScopedSessionStatus.Active),
          lte(agentScopedSessions.validUntilSec, beforeSec),
        ),
      )
      .returning({ sessionId: agentScopedSessions.sessionId });
    return rows.length;
  }

  /**
   * Wave 5 Option D · Commit 2 — `toDomain` accepts the post-`columns:
   * { enableData: false, enableSig: false }` shape that omits the
   * encrypted bytea columns. The shape is `Omit<...inferSelect, 'enableData' | 'enableSig'>`;
   * captured here as a structural type so the install-material path can
   * use a different mapper without overloading `toDomain` itself.
   */
  private toDomain(
    row: Omit<typeof agentScopedSessions.$inferSelect, 'enableData' | 'enableSig'>,
  ): ScopedSession {
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
    // Wave 5 Option D · Commit 2 — validate the new enable_status enum
    // at the read boundary too. Drizzle types it as the pgEnum union,
    // but defense-in-depth catches a hand-INSERT bypassing the column
    // type (mirrors the existing status check on line above).
    const enableStatusRaw = row.enableStatus;
    if (enableStatusRaw !== null && !isScopedSessionEnableStatus(enableStatusRaw)) {
      throw new Error(
        `pg-scoped-session: row ${row.sessionId} has invalid enable_status ${enableStatusRaw}`,
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
      // Wave 5 Option D · Commit 2 install-material lifecycle fields.
      // `enableData` + `enableSig` are NEVER on the default `ScopedSession`
      // (only on the install-material model); the schema's encrypted
      // bytea columns are excluded from the SELECT projection above.
      enableStatus: enableStatusRaw as ScopedSessionEnableStatus | null,
      validatorEnabledAt: row.validatorEnabledAt ?? null,
      validatorEnabledTxHash:
        (row.validatorEnabledTxHash as `0x${string}` | null) ?? null,
      validatorNonce:
        row.validatorNonce === null || row.validatorNonce === undefined
          ? null
          : Number(row.validatorNonce),
    });
  }
}
