/**
 * Wave 5 Q3 (step 4) — Postgres-backed `AuditWriter` impl. Replaces
 * `NoOpAuditWriter` for production cron + the future operator one-off
 * script. Writes against the `yield_distributions` table shipped in
 * step 1 (commit `a848a98`).
 *
 * Address-case-at-boundary: `tokenAddress` is lower-cased at every
 * write/read site. The schema's `yld_dist_token_address_lowercase`
 * CHECK constraint catches drift loud, but the writer doesn't depend
 * on the database for the lowering — keeping it client-side ensures
 * a future schema-drift (CHECK dropped) still produces sargable
 * resume queries via the `yld_dist_lower_token_unresolved_v1_idx`
 * partial functional index.
 *
 * BigInt → numeric serialisation: the `epoch_id` (numeric(78,0)),
 * `rate_per_share` and `enc_total_yield_usd6` (numeric(39,0)) columns
 * hold uint128/uint256 widths that JavaScript's safe-integer range
 * (~2^53) cannot represent. node-postgres returns `numeric` as string
 * by default + accepts string on insert; we convert via
 * `.toString()` / `BigInt(s)` at the boundary. NEVER use `Number()` —
 * silent precision loss on values > 2^53.
 *
 * Lifecycle:
 *
 *   1. `insertInProgress({ epochId, ratePerShare, encTotalYieldUsd6,
 *                          navAtTimeUsd, apyAtTimePercent })`
 *      → 1 row, `status='in_progress'`, `started_at = now()`.
 *
 *   2. `updateStatus(epochId, tokenAddress, status, fields?)`
 *      → UPDATE WHERE (lower(token_address), epoch_id) match. The
 *        partial unique constraint guarantees at most one match.
 *
 *   3. `findLatestUnresolved(tokenAddress)`
 *      → SELECT ... WHERE lower(token_address) = $1 AND status NOT IN
 *        ('success', 'failure') ORDER BY started_at DESC LIMIT 1.
 *        Uses the partial functional index — execution plan verified
 *        ≤ 0.05 ms (Database Optimizer M-1 smoke 2026-05-20).
 *
 * @see backend/src/infrastructure/blockchain/yield-epoch-runner.ts
 *      (AuditWriter contract + lifecycle invariants)
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import type {
  AuditRow,
  AuditStatus,
  AuditWriter,
  LowerAddress,
} from '../../blockchain/yield-epoch-runner.js';
import { yieldDistributions } from './schema.js';
import type { Db } from './db.js';

/**
 * Round-1 Security H-1 (2026-05-21) — `yield_distributions.
 * error_message` is the second emit surface for runner exceptions
 * (the first is the operator-alert Telegram path, which already runs
 * through `sanitizeAlertContext`). The audit row is a defense-in-
 * depth duplicate, but it persists in the DB indefinitely + may be
 * replicated to log ingestion or read by future admin APIs. Apply
 * the SAME regex-redact passes to `errorMessage` BEFORE writing.
 *
 * Inlined here (rather than importing the operator sanitiser) to
 * keep the `AuditWriter` impl coupled only to the audit-writer
 * concern — the runner's contract is "no relative imports into
 * application/use-case modules" and the writer inherits that.
 *
 * Regex set mirrors `sanitize-alert-context.ts` (anchored 64-hex
 * for tx-hashes / FHE handles, 40-hex with negative-lookahead for
 * addresses, base64-shaped opaque blobs). Order matters: 64-hex
 * before 40-hex so a tx-hash prefix doesn't get partial-matched
 * as an address.
 */
const TX_HASH_RE = /0x[a-fA-F0-9]{64,}/g;
const ADDRESS_RE = /0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g;
const OPAQUE_BLOB_RE = /[A-Za-z0-9+/]{40,}={0,2}/g;
const MAX_ERROR_MESSAGE_LEN = 1024;

export function redactAuditErrorMessage(msg: string): string {
  let out = msg.slice(0, MAX_ERROR_MESSAGE_LEN);
  out = out.replace(TX_HASH_RE, '0x…tx');
  out = out.replace(ADDRESS_RE, '0x…addr');
  out = out.replace(OPAQUE_BLOB_RE, '[…opaque]');
  return out;
}

export class PgAuditWriter implements AuditWriter {
  constructor(private readonly db: Db) {}

  async insertInProgress(row: {
    tokenAddress: LowerAddress;
    epochId: bigint;
    ratePerShare: bigint;
    encTotalYieldUsd6: bigint;
    navAtTimeUsd: string;
    apyAtTimePercent: string;
  }): Promise<void> {
    const tokenAddress = row.tokenAddress.toLowerCase();
    await this.db.insert(yieldDistributions).values({
      id: randomUUID(),
      tokenAddress,
      epochId: row.epochId.toString(),
      ratePerShare: row.ratePerShare.toString(),
      encTotalYieldUsd6: row.encTotalYieldUsd6.toString(),
      navAtTimeUsd: row.navAtTimeUsd,
      apyAtTimePercent: row.apyAtTimePercent,
      status: 'in_progress',
    });
  }

  async updateStatus(
    epochId: bigint,
    tokenAddress: LowerAddress,
    status: AuditStatus,
    fields?: {
      fundEpochTxHash?: string;
      finishedAt?: Date;
      lastResumedAt?: Date;
      errorClass?: string;
      errorMessage?: string;
      encTotalYieldUsd6?: bigint;
    },
  ): Promise<void> {
    // Build the SET clause from the union of `status` + any provided
    // optional fields. Skipping `undefined` keys avoids stomping
    // existing column values on partial updates (e.g. the runner's
    // `audit.updateStatus(... 'snapshot_done')` after open-epoch
    // should preserve the navAtTimeUsd / apyAtTimePercent the
    // insertInProgress just stamped).
    //
    // `as const` shape mirrors drizzle's update-set type without
    // pulling the InferInsertModel<typeof yieldDistributions> generic
    // (which would force the optional-field plumbing through the type
    // system unnecessarily).
    const set: Record<string, unknown> = { status };
    if (fields?.fundEpochTxHash !== undefined) set.fundEpochTxHash = fields.fundEpochTxHash;
    if (fields?.finishedAt !== undefined) set.finishedAt = fields.finishedAt;
    if (fields?.lastResumedAt !== undefined) set.lastResumedAt = fields.lastResumedAt;
    if (fields?.errorClass !== undefined) set.errorClass = fields.errorClass;
    // Round-1 Security H-1 (2026-05-21): redact addresses / tx-hashes /
    // FHE handles / base64 blobs from runner error messages before
    // they land in the audit row. See top-of-file rationale.
    if (fields?.errorMessage !== undefined)
      set.errorMessage = redactAuditErrorMessage(fields.errorMessage);
    // FU-1 (Wave 5 W2): the snapshot-funding runner re-stamps the
    // actually-funded amount at the `snapshot_done` transition. Serialise
    // via `.toString()` (numeric(39,0) holds uint128 widths beyond JS
    // safe-integer range — same boundary rule as `insertInProgress`).
    if (fields?.encTotalYieldUsd6 !== undefined)
      set.encTotalYieldUsd6 = fields.encTotalYieldUsd6.toString();
    await this.db
      .update(yieldDistributions)
      .set(set)
      .where(
        and(
          eq(yieldDistributions.tokenAddress, tokenAddress.toLowerCase()),
          eq(yieldDistributions.epochId, epochId.toString()),
        ),
      );
  }

  async findLatestUnresolved(tokenAddress: LowerAddress): Promise<AuditRow | null> {
    const tokenLower = tokenAddress.toLowerCase();
    // `lower(token_address) = $1` matches the partial functional
    // index `yld_dist_lower_token_unresolved_v1_idx` (DB review M-1).
    // The CHECK constraint guarantees the column is already lower-
    // cased, but keeping the functional predicate here is what makes
    // the planner reach the index — `token_address = $1` (plain eq)
    // would force a sequential scan despite the CHECK invariant.
    const rows = await this.db
      .select()
      .from(yieldDistributions)
      .where(
        and(
          sql`lower(${yieldDistributions.tokenAddress}) = ${tokenLower}`,
          notInArray(yieldDistributions.status, ['success', 'failure']),
        ),
      )
      .orderBy(desc(yieldDistributions.startedAt))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      tokenAddress: r.tokenAddress,
      epochId: BigInt(r.epochId),
      ratePerShare: BigInt(r.ratePerShare),
      encTotalYieldUsd6: BigInt(r.encTotalYieldUsd6),
      status: r.status as AuditStatus,
      fundEpochTxHash: r.fundEpochTxHash ?? null,
    };
  }
}
