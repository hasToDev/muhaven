/**
 * 2026-05-19 — Wave 5 zero-burn retirement: transitions the legacy
 * demo tokens (TBILL1 / GOLD1) into the `winding_down` lifecycle
 * state. Existing holders keep their balances (no on-chain change,
 * no burn, no conversion); the UI gates new buys on `status ===
 * 'active'` so the Trade page surfaces a deprecation banner instead
 * of a Buy CTA. Read `development/DEV_WAVE_5/TBILL1_GOLD1_RETIREMENT.md`
 * for the full decision rationale.
 *
 * What this script does:
 *   UPDATE rwa_tokens
 *      SET status = 'winding_down',
 *          winding_down_at = NOW(),
 *          updated_at = NOW()
 *    WHERE UPPER(symbol) IN ('TBILL1', 'GOLD1')
 *      AND status = 'active';
 *
 * Non-destructive — no rows deleted, no holdings affected. Idempotent:
 * re-running after a successful retirement finds zero rows to update
 * (the status='active' filter ensures we don't bounce already-retired
 * tokens back through the winding_down_at timestamp).
 *
 * Operator workflow:
 *
 *   # 1. PREVIEW — no writes, shows which rows would transition.
 *   docker compose -f docker-compose.yml -p muhaven exec -T backend \
 *     pnpm tsx scripts/retire-legacy-tokens.ts --dry-run
 *
 *   # 2. EXECUTE — applies the UPDATE.
 *   docker compose -f docker-compose.yml -p muhaven exec -T backend \
 *     pnpm tsx scripts/retire-legacy-tokens.ts --confirm
 *
 * Staging path (same shape):
 *   docker compose -f docker-compose.stage.yml -p muhaven-stage exec -T backend \
 *     pnpm tsx scripts/retire-legacy-tokens.ts --dry-run
 *   # then --confirm for the real run
 *
 * Reverting: the inverse SQL is one line if you ever need to roll back —
 *   UPDATE rwa_tokens SET status='active', winding_down_at=NULL
 *    WHERE UPPER(symbol) IN ('TBILL1','GOLD1') AND status='winding_down';
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../src/infrastructure/repository/postgres/db.js';
import { rwaTokens } from '../src/infrastructure/repository/postgres/schema.js';

const LEGACY_SYMBOLS = ['TBILL1', 'GOLD1'] as const;

interface ParsedArgs {
  dryRun: boolean;
  confirmed: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  return {
    dryRun: argv.includes('--dry-run'),
    confirmed: argv.includes('--confirm'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  console.log('=== retire-legacy-tokens ===');
  console.log(`mode: ${args.dryRun ? 'DRY-RUN (no writes)' : args.confirmed ? 'EXECUTE' : 'NO-OP'}`);
  console.log(`target symbols: ${LEGACY_SYMBOLS.join(', ')}\n`);

  if (!args.dryRun && !args.confirmed) {
    console.error(
      'ERROR: pass either --dry-run (preview) or --confirm (execute).',
    );
    process.exit(2);
  }

  const db = getDb();

  await db.transaction(async (tx) => {
    // Resolve symbols → rows. Case-insensitive on `symbol` because seed
    // scripts have historically mixed casing; UPPER() on both sides
    // immunizes against that drift. Filter to status='active' so a
    // re-run on already-retired tokens reports "nothing to do" rather
    // than re-stamping winding_down_at.
    const targets = await tx
      .select({
        id: rwaTokens.id,
        address: rwaTokens.address,
        symbol: rwaTokens.symbol,
        status: rwaTokens.status,
      })
      .from(rwaTokens)
      .where(
        and(
          inArray(
            sql`UPPER(${rwaTokens.symbol})`,
            LEGACY_SYMBOLS.map((s) => s.toUpperCase()),
          ),
          eq(rwaTokens.status, 'active'),
        ),
      );

    if (targets.length === 0) {
      console.log('No active TBILL1/GOLD1 rows found — already retired or not present.');
      return;
    }

    console.log(`Found ${targets.length} active row(s) to transition → winding_down:`);
    for (const r of targets) {
      console.log(`  - ${r.symbol.padEnd(8)} ${r.address}  (id=${r.id})`);
    }
    console.log();

    if (args.dryRun) {
      console.log('--dry-run set; no writes performed. To execute:');
      console.log('  --confirm');
      return;
    }

    const now = new Date();
    const updated = await tx
      .update(rwaTokens)
      .set({
        status: 'winding_down',
        // COALESCE so a previously-stamped `winding_down_at` survives
        // the rare "rollback to active → re-retire" cycle. The first
        // retirement timestamp is what matters for downstream audit
        // (holder-notice windows, archival math); re-running this
        // script after a manual revert should NOT erase it.
        windingDownAt: sql`COALESCE(${rwaTokens.windingDownAt}, ${now})`,
        updatedAt: now,
      })
      .where(
        inArray(
          rwaTokens.id,
          targets.map((t) => t.id),
        ),
      );

    console.log(`rwa_tokens: updated ${updated.rowCount ?? targets.length} row(s) → status=winding_down`);
    console.log();
    console.log('Done. Re-run with --dry-run to confirm zero remaining matches.');
    console.log(
      'NEXT: frontend Trade page gates Buy CTA on status="active"; ' +
        'Portfolio page tags holdings with a "Winding down" badge.',
    );
  });
}

main().catch((err) => {
  console.error('retire-legacy-tokens failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
