/**
 * 2026-05-18 — Demo-prep cleanup: remove obsolete RWA tokens from the
 * backend catalog so the marketplace + activity feed + portfolio pages
 * render only the currently-supported set (TBILL1, GOLD1) instead of
 * a long tail of artifacts from prior testnet deployments.
 *
 * Target symbols (hard-coded — operator edits the constant below if
 * the obsolete set changes for a future demo cycle):
 *   NOVUS, OCEAN, ASTRAT, TESTRUN2, SUMMIT
 *
 * These tokens still EXIST on the on-chain TokenRegistry (we can't
 * un-register without a registry-side admin path that doesn't ship
 * today), so a subsequent `pnpm seed:tokens:v35` run would re-create
 * the `rwa_tokens` rows. The script header WARNs about this; the
 * operator-facing burndown is to skip `seed:tokens:v35` until the
 * demo is recorded, OR to add the obsolete addresses to a blocklist
 * inside `seed-tokens-v35.ts` (out of scope for this script).
 *
 * Cleanup scope (all delete operations gated by --confirm-addresses):
 *   1. `tax_events` rows referencing any of the obsolete tokens
 *      (cleared so the /activity feed doesn't show ghost buy/sell
 *      events for tokens the marketplace no longer surfaces).
 *   2. `token_nav_history` rows for the obsolete tokens (drops the
 *      time-series the nav-worker accumulated against orphaned addrs).
 *   3. `portfolios` rows referencing the obsolete tokens (per-user
 *      "you hold X" entries clean up across every wallet).
 *   4. `yield_records` rows for the obsolete tokens (legacy Wave 3
 *      yield-claim ledger; not currently surfaced but cleaner gone).
 *   5. `escrows` rows for the obsolete tokens (legacy platform-modules
 *      escrow ledger; may have orphan rows from prior testnet activity).
 *   6. FINALLY `rwa_tokens` rows (the source-of-truth catalog).
 *
 * NOT drained: `issuer_token_deploys.result_token_address` — that's
 * the F2 wizard's operational audit trail of who deployed which
 * token. Even when the resulting token is obsolete, the historical
 * deploy fact stays for issuer-dashboard continuity. Manual SQL DELETE
 * if you really want to wipe the F2 wizard history too.
 *
 * Order matters only insofar as the operator can stop after step N
 * and re-run later — none of the tables have FK references back to
 * `rwa_tokens.id` (verified via schema grep 2026-05-18), so deleting
 * the catalog row first wouldn't cascade. The dependent-first order
 * keeps the logs readable as "drained, then removed".
 *
 * Safety rails (Code Reviewer C2 + Security F4, 2026-05-18 post-review):
 *
 *   - **No FOR UPDATE on aggregate**: an earlier draft combined
 *     `SELECT COUNT(*) … FOR UPDATE` which Postgres rejects with
 *     `ERROR: FOR UPDATE is not allowed with aggregate functions`.
 *     The deletes acquire their own ROW EXCLUSIVE locks at execution;
 *     the advisory lock serializes concurrent script runs; a concurrent
 *     backend write (a fresh tax_event from the indexer, a new
 *     portfolio row from /addPosition) is absorbed cleanly — the
 *     DELETE just sees one more / one fewer row to remove. No data
 *     loss class introduced.
 *
 *   - **Symbol-resurrection defense**: a future issuer onboarding a
 *     token with one of OBSOLETE_SYMBOLS would silently inherit the
 *     destructive nuke on the next script re-run. To prevent this:
 *     the real-run path REQUIRES `--confirm-addresses=0xabc,0xdef,...`
 *     and aborts unless the resolved catalog set matches the
 *     comma-separated list byte-for-byte (case-insensitive on the
 *     hex). Operator workflow is documented below — dry-run first,
 *     paste the resolved addresses back as the confirm arg.
 *
 * Operator workflow (prod, two-pass — symbol-resurrection defense):
 *
 *   # 1. PREVIEW: resolve symbols → addresses, count dependent rows,
 *   #    print the addresses you'll need to paste in step 2. No writes.
 *   docker compose -f docker-compose.yml -p muhaven exec -T backend \
 *     pnpm tsx scripts/cleanup-obsolete-tokens.ts --dry-run
 *
 *   # 2. EXECUTE: paste the resolved addresses from step 1's output.
 *   #    The script aborts if they don't match the current catalog
 *   #    (defense against a new issuer registering one of the
 *   #    OBSOLETE_SYMBOLS between dry-run and real-run).
 *   docker compose -f docker-compose.yml -p muhaven exec -T backend \
 *     pnpm tsx scripts/cleanup-obsolete-tokens.ts \
 *       --confirm-addresses=0xabc...,0xdef...,0x123...,0x456...,0x789...
 *
 * Staging (same two-pass shape):
 *   docker compose -f docker-compose.stage.yml -p muhaven-stage exec -T backend \
 *     pnpm tsx scripts/cleanup-obsolete-tokens.ts --dry-run
 *   # then --confirm-addresses=... for the real run
 *
 * Idempotent — re-running after a successful cleanup finds zero rows
 * to remove and exits cleanly (dry-run reports zero matches; real-run
 * requires --confirm-addresses but accepts an empty list when there
 * are no resolved rows).
 *
 * WARNING (destructive): This script DELETES rows for the listed
 * symbols across 6 tables. Run --dry-run first; visually verify the
 * counts match expectations.
 *
 * WARNING (resurrection): If an operator runs `pnpm seed:tokens:v35`
 * AFTER this script, the catalog row will reappear (the seed script
 * discovers tokens from the on-chain TokenRegistry, which still has
 * them registered). Per-table dependent data won't return (tax_events
 * et al. are user-write-driven, not seed-driven), but the marketplace
 * will list the obsolete symbol again. Keep this in mind for the
 * recording window — don't re-seed between the cleanup and the demo
 * recording.
 */

import { inArray, sql } from 'drizzle-orm';
import { getDb } from '../src/infrastructure/repository/postgres/db.js';
import {
  escrows,
  portfolios,
  rwaTokens,
  taxEvents,
  tokenNavHistory,
  yieldRecords,
} from '../src/infrastructure/repository/postgres/schema.js';

/**
 * Symbols to remove. Edit if the obsolete-set changes for a future
 * demo cycle. Symbols are matched case-insensitive against the
 * `rwa_tokens.symbol` column; resolved addresses cascade to the
 * dependent tables.
 */
const OBSOLETE_SYMBOLS = ['NOVUS', 'OCEAN', 'ASTRAT', 'TESTRUN2', 'SUMMIT'] as const;

const ADVISORY_LOCK_TAG = sql`hashtext('cleanup-obsolete-tokens')`;

interface ParsedArgs {
  dryRun: boolean;
  /** Comma-separated 0x-addresses the operator confirmed in the real-run.
   *  `null` when no --confirm-addresses flag was passed. */
  confirmAddresses: readonly string[] | null;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const dryRun = argv.includes('--dry-run');
  const flag = argv.find((a) => a.startsWith('--confirm-addresses='));
  if (!flag) return { dryRun, confirmAddresses: null };
  const raw = flag.slice('--confirm-addresses='.length).trim();
  if (raw === '') return { dryRun, confirmAddresses: [] };
  const addrs = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  for (const a of addrs) {
    if (!/^0x[0-9a-f]{40}$/.test(a)) {
      throw new Error(
        `--confirm-addresses entry "${a}" is not a valid 0x-prefixed 20-byte hex address.`,
      );
    }
  }
  return { dryRun, confirmAddresses: addrs };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const db = getDb();

  console.log('=== cleanup-obsolete-tokens ===');
  console.log(`dry-run: ${args.dryRun ? 'YES (no writes)' : 'NO (will DELETE rows)'}`);
  if (args.confirmAddresses !== null) {
    console.log(`confirm-addresses provided: ${args.confirmAddresses.length} entries`);
  }
  console.log(`target symbols: ${OBSOLETE_SYMBOLS.join(', ')}\n`);

  // Real-run requires --confirm-addresses. Refuse early so the operator
  // doesn't drop into the dependent-count surface only to find out the
  // delete step is gated.
  if (!args.dryRun && args.confirmAddresses === null) {
    console.error(
      'ERROR: real-run requires --confirm-addresses=0xabc...,0xdef... ' +
        '(paste the addresses from the --dry-run output). Re-run with --dry-run first.',
    );
    process.exit(2);
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_TAG})`);

    // Resolve symbols → catalog rows. Case-insensitive on the symbol
    // column; UPPER() both sides immunizes against past seeds that
    // wrote mixed-case symbols.
    const targetRows = await tx
      .select({
        id: rwaTokens.id,
        address: rwaTokens.address,
        symbol: rwaTokens.symbol,
      })
      .from(rwaTokens)
      .where(
        inArray(
          sql`UPPER(${rwaTokens.symbol})`,
          OBSOLETE_SYMBOLS.map((s) => s.toUpperCase()),
        ),
      );

    if (targetRows.length === 0) {
      console.log('No rwa_tokens rows match any of the target symbols — nothing to do.');
      return;
    }

    console.log(`Found ${targetRows.length} catalog row(s) to remove:`);
    for (const r of targetRows) {
      console.log(`  - ${r.symbol.padEnd(10)} ${r.address}  (id=${r.id})`);
    }
    console.log();

    // Address-pinning safety (Security F4): if the operator passed
    // --confirm-addresses, verify it matches the resolved set exactly.
    // This catches the resurrection class — a new issuer onboarding a
    // token with one of OBSOLETE_SYMBOLS between dry-run and real-run.
    const addrLowers = targetRows.map((r) => r.address.toLowerCase());
    const tokenIds = targetRows.map((r) => r.id);

    if (args.confirmAddresses !== null) {
      const expected = new Set(addrLowers);
      const confirmed = new Set(args.confirmAddresses);
      const missing = [...expected].filter((a) => !confirmed.has(a));
      const extra = [...confirmed].filter((a) => !expected.has(a));
      if (missing.length > 0 || extra.length > 0) {
        console.error('ERROR: --confirm-addresses does NOT match the resolved catalog.');
        if (missing.length > 0) {
          console.error('  Resolved but NOT confirmed:');
          for (const a of missing) console.error(`    ${a}`);
        }
        if (extra.length > 0) {
          console.error('  Confirmed but NOT in resolved set:');
          for (const a of extra) console.error(`    ${a}`);
        }
        console.error(
          '  Re-run --dry-run, copy the addresses, and pass them as --confirm-addresses.',
        );
        throw new Error('confirm-addresses mismatch — aborting');
      }
      console.log('--confirm-addresses matches the resolved catalog ✓\n');
    }

    // ---- Count dependent rows. No FOR UPDATE — that combined with
    // COUNT(*) is illegal SQL in Postgres (Code Reviewer C2). The
    // DELETEs below acquire their own row locks at execution; the
    // advisory lock serializes concurrent script runs; a concurrent
    // backend write to one of these tables blocks on the row lock the
    // DELETE acquires, then proceeds — no data class is harmed.

    const taxEventCountRows = await tx
      .select({ c: sql<string>`COUNT(*)::text` })
      .from(taxEvents)
      .where(inArray(sql`LOWER(${taxEvents.tokenAddress})`, addrLowers));
    const taxEventRowCount = Number(taxEventCountRows[0]?.c ?? '0');
    console.log(`tax_events:        ${taxEventRowCount} row(s) match`);

    const navHistoryCountRows = await tx
      .select({ c: sql<string>`COUNT(*)::text` })
      .from(tokenNavHistory)
      .where(inArray(sql`LOWER(${tokenNavHistory.tokenAddress})`, addrLowers));
    const navHistoryRowCount = Number(navHistoryCountRows[0]?.c ?? '0');
    console.log(`token_nav_history: ${navHistoryRowCount} row(s) match`);

    const portfolioCountRows = await tx
      .select({ c: sql<string>`COUNT(*)::text` })
      .from(portfolios)
      .where(inArray(sql`LOWER(${portfolios.tokenAddress})`, addrLowers));
    const portfolioRowCount = Number(portfolioCountRows[0]?.c ?? '0');
    console.log(`portfolios:        ${portfolioRowCount} row(s) match`);

    const yieldCountRows = await tx
      .select({ c: sql<string>`COUNT(*)::text` })
      .from(yieldRecords)
      .where(inArray(sql`LOWER(${yieldRecords.tokenAddress})`, addrLowers));
    const yieldRowCount = Number(yieldCountRows[0]?.c ?? '0');
    console.log(`yield_records:     ${yieldRowCount} row(s) match`);

    // `escrows.token_address` is nullable (legacy ReineiraOS rows may
    // have it set; MuHaven-cutover rows usually don't). Count both
    // anyway — DELETE skips NULL via the IN-list semantics.
    const escrowCountRows = await tx
      .select({ c: sql<string>`COUNT(*)::text` })
      .from(escrows)
      .where(inArray(sql`LOWER(${escrows.tokenAddress})`, addrLowers));
    const escrowRowCount = Number(escrowCountRows[0]?.c ?? '0');
    console.log(`escrows:           ${escrowRowCount} row(s) match`);

    console.log();
    console.log(`rwa_tokens:        ${targetRows.length} row(s) match (to delete LAST)`);
    console.log();

    if (args.dryRun) {
      console.log('--dry-run set; transaction will roll back. To execute:');
      const confirmList = addrLowers.join(',');
      console.log(`  --confirm-addresses=${confirmList}`);
      console.log('Paste the above as the --confirm-addresses arg on the real run.');
      return;
    }

    // ---- Execute deletes in dependent-first order. ----
    if (taxEventRowCount > 0) {
      const r = await tx
        .delete(taxEvents)
        .where(inArray(sql`LOWER(${taxEvents.tokenAddress})`, addrLowers));
      console.log(`tax_events:        deleted ${r.rowCount ?? taxEventRowCount} row(s)`);
    }

    if (navHistoryRowCount > 0) {
      const r = await tx
        .delete(tokenNavHistory)
        .where(inArray(sql`LOWER(${tokenNavHistory.tokenAddress})`, addrLowers));
      console.log(`token_nav_history: deleted ${r.rowCount ?? navHistoryRowCount} row(s)`);
    }

    if (portfolioRowCount > 0) {
      const r = await tx
        .delete(portfolios)
        .where(inArray(sql`LOWER(${portfolios.tokenAddress})`, addrLowers));
      console.log(`portfolios:        deleted ${r.rowCount ?? portfolioRowCount} row(s)`);
    }

    if (yieldRowCount > 0) {
      const r = await tx
        .delete(yieldRecords)
        .where(inArray(sql`LOWER(${yieldRecords.tokenAddress})`, addrLowers));
      console.log(`yield_records:     deleted ${r.rowCount ?? yieldRowCount} row(s)`);
    }

    if (escrowRowCount > 0) {
      const r = await tx
        .delete(escrows)
        .where(inArray(sql`LOWER(${escrows.tokenAddress})`, addrLowers));
      console.log(`escrows:           deleted ${r.rowCount ?? escrowRowCount} row(s)`);
    }

    // ---- Step 6: rwa_tokens (catalog). Last so a failure above
    // ---- leaves the catalog row visible for re-run diagnosis. ----
    const catalogDeleted = await tx.delete(rwaTokens).where(inArray(rwaTokens.id, tokenIds));
    console.log(`rwa_tokens:        deleted ${catalogDeleted.rowCount ?? targetRows.length} row(s)`);

    console.log();
    console.log('Done. Re-run with --dry-run to confirm zero remaining matches.');
    console.log(
      'REMINDER: do NOT run `pnpm seed:tokens:v35` until the demo is recorded — ' +
        'it would re-create the catalog rows from the on-chain registry.',
    );
  });
}

main().catch((err) => {
  console.error('cleanup-obsolete-tokens failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
