/**
 * 2026-05-17 — backfill: dedup + lowercase `portfolios.token_address`.
 *
 * Wave 4 / Demo-prep follow-up: surfaced 2026-05-17 when /portfolio
 * rendered TBILL1 twice. Root cause: the prior `pg-portfolio.repository`
 * compared `token_address` byte-exact (no lower() wrap), so a row
 * inserted via the TradePage flow in EIP-55 checksum case (`0x8D77...`)
 * AND a row inserted via the agent post-buy hook in lowercase
 * (`0x8d77...`) both landed. The unique index on (user_id,
 * token_address) is ALSO byte-exact, so it didn't catch the dup either.
 *
 * The repo is now case-normalized at the boundary (see
 * `pg-portfolio.repository.ts` 2026-05-17 fix) so NEW writes can't
 * regress. This script cleans the existing rows.
 *
 * Idempotent: re-running on already-clean data is a no-op (the dedup
 * window is empty, the lowercase UPDATE matches no rows).
 *
 * Strategy (single transaction, 2026-05-18 hardened):
 *   1. Acquire a pg_advisory_xact_lock keyed on the script name so two
 *      concurrent runs can't interleave (operator pastes the command
 *      twice, etc).
 *   2. Inside the same transaction, SELECT FOR UPDATE locks every
 *      portfolios row that's about to be inspected — concurrent backend
 *      writers (PgPortfolioRepository.save) block on the lock instead
 *      of racing the dedup decision. This closes the TOCTOU window
 *      Security review H-1 flagged: pre-2026-05-18, the discovery
 *      SELECT ran outside the transaction so a backend INSERT between
 *      snapshot and DELETE could either lose a freshly-recorded row
 *      (`last_synced_at` bumped post-snapshot, then deleted) or leave
 *      mixed-case rows the script didn't see.
 *   3. For every (user_id, lower(token_address)) group with >1 row,
 *      keep the row with the most-recent `last_synced_at` (tiebreak by
 *      lexicographic `id`) and DELETE the rest. Preserves the "freshest
 *      activity" — agent post-buy lowercase row usually wins over the
 *      older TradePage checksum row, which matches what addPosition
 *      callers expect (case-normalized at the repo).
 *   4. After dedup, UPDATE any remaining rows to lowercase. No
 *      conflicts can arise (each (user_id, lower(addr)) has exactly
 *      one row by this point).
 *
 * portfolios.id has no FK references (verified via schema grep
 * 2026-05-17), so deleting a row by id is safe — no cascade concerns.
 *
 * Operator workflow (recommended):
 *   bash scripts/dedup-portfolios.ts --dry-run     # preview
 *   bash scripts/dedup-portfolios.ts               # execute (still uses tx + lock)
 *
 * Usage (inside the prod container):
 *   docker compose -f docker-compose.yml -p muhaven exec -T backend \
 *     pnpm tsx scripts/dedup-portfolios.ts --dry-run
 *
 * Staging:
 *   docker compose -f docker-compose.stage.yml -p muhaven-stage exec -T backend \
 *     pnpm tsx scripts/dedup-portfolios.ts --dry-run
 *
 * Concurrency model: the advisory lock + SELECT FOR UPDATE means
 * concurrent backend writes BLOCK on the affected rows for the
 * duration of the transaction (~50-500ms on realistic dup counts).
 * That's a brief user-visible pause for any in-flight buy, NOT data
 * loss. If the operator is paranoid about even that brief stall, stop
 * the backend container first: `docker compose stop backend`, run the
 * script, restart. The lock pattern just removes the requirement.
 */
import { inArray, sql } from 'drizzle-orm';
import { getDb } from '../src/infrastructure/repository/postgres/db.js';
import { portfolios } from '../src/infrastructure/repository/postgres/schema.js';

interface DupGroup {
  user_id: string;
  lower_addr: string;
  keep_id: string;
  delete_ids: string[];
  total: number;
}

/**
 * pg_advisory_xact_lock keyspace tag (32-bit signed). Hashed from the
 * literal script name so two scripts that pick the same constant don't
 * collide — `pg_advisory_xact_lock(hashtext('dedup-portfolios'))` is
 * stable across runs but doesn't conflict with unrelated migration
 * scripts.
 */
const ADVISORY_LOCK_TAG = sql`hashtext('dedup-portfolios')`;

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = getDb();

  // 2026-05-18 hardening: run discovery AND mutation inside the same
  // transaction, gated by a pg_advisory_xact_lock so two concurrent
  // runs serialize cleanly. Inside the transaction, SELECT FOR UPDATE
  // locks the candidate rows so backend writers (PgPortfolioRepository.
  // save) block until commit/rollback rather than racing the dedup
  // decision.
  //
  // Dry-run still opens the tx (so the SELECT view is consistent) but
  // returns before any mutation; tx auto-rolls-back on the implicit
  // `return` since no commit happened.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_TAG})`);

    // Discover dup groups + lock the rows. SELECT FOR UPDATE inside the
    // GROUP BY is invalid SQL; we run two phases:
    //   1. SELECT the IDs of every row that's about to be considered
    //      (i.e. every row in any (user_id, lower(addr)) group with >1
    //      row) and lock those rows with SELECT ... FOR UPDATE.
    //   2. Run the actual GROUP BY against the locked-row view.
    //
    // The lock acquired in phase 1 holds for the rest of the tx, so the
    // GROUP BY in phase 2 sees a stable snapshot — concurrent writers
    // either committed before phase 1's lock (visible to phase 2) or
    // block until our tx commits/rolls-back.
    await tx.execute(sql`
      SELECT id FROM portfolios
      WHERE (user_id, LOWER(token_address)) IN (
        SELECT user_id, LOWER(token_address) FROM portfolios
        GROUP BY user_id, LOWER(token_address)
        HAVING COUNT(*) > 1
      )
      FOR UPDATE
    `);
    // Also lock mixed-case rows so the lowercase UPDATE step doesn't
    // collide with a concurrent insert of the same canonical form.
    await tx.execute(sql`
      SELECT id FROM portfolios
      WHERE token_address != LOWER(token_address)
      FOR UPDATE
    `);

    const groups = await tx.execute<{
      user_id: string;
      lower_addr: string;
      ids: string[];
      last_synced_ats: (string | null)[];
    }>(sql`
      SELECT
        user_id,
        LOWER(token_address) AS lower_addr,
        ARRAY_AGG(id ORDER BY last_synced_at DESC NULLS LAST, id) AS ids,
        ARRAY_AGG(last_synced_at ORDER BY last_synced_at DESC NULLS LAST, id) AS last_synced_ats
      FROM portfolios
      GROUP BY user_id, LOWER(token_address)
      HAVING COUNT(*) > 1
    `);

    const dupGroups: DupGroup[] = groups.rows.map((r) => ({
      user_id: r.user_id,
      lower_addr: r.lower_addr,
      keep_id: r.ids[0]!,
      delete_ids: r.ids.slice(1),
      total: r.ids.length,
    }));

    console.log(`[dedup-portfolios] dup groups: ${dupGroups.length}`);
    for (const g of dupGroups) {
      console.log(
        `  user=${g.user_id} addr=${g.lower_addr} keep=${g.keep_id} delete=${g.delete_ids.length} (of ${g.total})`,
      );
    }

    const mixedCase = await tx.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM portfolios
      WHERE token_address != LOWER(token_address)
    `);
    const mixedCaseCount = Number(mixedCase.rows[0]?.count ?? '0');
    console.log(`[dedup-portfolios] mixed-case rows: ${mixedCaseCount}`);

    if (dupGroups.length === 0 && mixedCaseCount === 0) {
      console.log('[dedup-portfolios] already clean — exiting');
      return;
    }

    if (dryRun) {
      console.log('[dedup-portfolios] --dry-run set; no writes performed');
      return;
    }

    // Step A: delete dup rows.
    const deleteIds = dupGroups.flatMap((g) => g.delete_ids);
    if (deleteIds.length > 0) {
      // Use Drizzle's inArray() rather than `sql\`... ANY(${ids})\``
      // because pg's text-protocol parameter binding can't round-trip
      // a JS array as a Postgres `text[]` literal — it surfaces as
      // `array_in: Array value must start with "{" or dimension info`.
      // inArray() expands to `IN ($1, $2, ...)` with one bind per id.
      const result = await tx.delete(portfolios).where(inArray(portfolios.id, deleteIds));
      console.log(`[dedup-portfolios] deleted ${result.rowCount ?? deleteIds.length} dup row(s)`);
    }
    // Step B: lowercase any remaining mixed-case rows.
    const upd = await tx.execute(sql`
      UPDATE portfolios
      SET token_address = LOWER(token_address)
      WHERE token_address != LOWER(token_address)
    `);
    console.log(`[dedup-portfolios] lowercased ${upd.rowCount ?? 0} mixed-case row(s)`);
  });

  console.log('[dedup-portfolios] done');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[dedup-portfolios] FAILED:', err);
    process.exit(1);
  });
