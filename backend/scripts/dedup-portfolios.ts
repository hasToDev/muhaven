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
 * Strategy:
 *   1. For every (user_id, lower(token_address)) group with >1 row,
 *      keep the row with the most-recent `last_synced_at` (tiebreak by
 *      lexicographic `id`) and DELETE the rest. Preserves the "freshest
 *      activity" — agent post-buy lowercase row usually wins over the
 *      older TradePage checksum row, which matches what addPosition
 *      callers expect (case-normalized at the repo).
 *   2. After dedup, UPDATE any remaining rows to lowercase. No
 *      conflicts can arise (each (user_id, lower(addr)) has exactly
 *      one row by this point).
 *
 * Single transaction so partial-failure is impossible. portfolios.id
 * has no FK references (verified via schema grep 2026-05-17), so
 * deleting a row by id is safe — no cascade concerns.
 *
 * Usage (inside the prod container):
 *   docker compose -f docker-compose.yml -p muhaven exec -T backend \
 *     pnpm tsx scripts/dedup-portfolios.ts
 *
 * Staging:
 *   docker compose -f docker-compose.stage.yml -p muhaven-stage exec -T backend \
 *     pnpm tsx scripts/dedup-portfolios.ts
 *
 * Add --dry-run to print what WOULD be deleted/updated without writing.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../src/infrastructure/repository/postgres/db.js';

interface DupGroup {
  user_id: string;
  lower_addr: string;
  keep_id: string;
  delete_ids: string[];
  total: number;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = getDb();

  // Discover dup groups before mutating so we can print a useful report.
  // Uses Drizzle's raw-SQL escape hatch because the row_number() window
  // is cleaner than a multi-step CTE through the query builder.
  const groups = await db.execute<{
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

  // Count rows that still need a case-normalize after dedup.
  const mixedCase = await db.execute<{ count: string }>(sql`
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

  // Single transaction. Step 1: delete dup rows. Step 2: lowercase
  // remaining mixed-case rows.
  await db.transaction(async (tx) => {
    const deleteIds = dupGroups.flatMap((g) => g.delete_ids);
    if (deleteIds.length > 0) {
      const result = await tx.execute(sql`
        DELETE FROM portfolios WHERE id = ANY(${deleteIds})
      `);
      console.log(`[dedup-portfolios] deleted ${result.rowCount ?? deleteIds.length} dup row(s)`);
    }
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
