/**
 * Wave 5 Q1 — one-shot seed for MuHaven's editorial override of
 * rwa.xyz's `isYieldBearing` classification.
 *
 * rwa.xyz flags ONLY USYC / BUIDL / USDY as yield-bearing among the 11
 * curated assets. MuHaven treats CETES / EUTBL / syrupUSDC / ONyc as
 * yield-bearing too — they all have meaningful APY data; the rwa.xyz
 * flag captures something subtler about whether the wrapper passes
 * yield through to holders, which is not how MuHaven wants to surface
 * them.
 *
 * Effect: when the read endpoint computes
 *   isYieldBearing = override ?? rwaxyz_flag
 * those four tickers will read `true` even though the raw column is
 * `false`. The Q3 daily-distribution cron + the marketplace APY card
 * variant consume the EFFECTIVE flag.
 *
 * USAGE:
 *   # locally
 *   cd backend && DATABASE_URL=postgresql://… pnpm exec tsx \
 *     scripts/seed-yield-bearing-overrides.ts
 *
 *   # against homelab stage (run inside the backend container so
 *   # DATABASE_URL is the in-network postgres URL):
 *   ssh muhaven@192.168.1.52 \
 *     'cd /home/muhaven/Project/Fhenix/MuHaven-stage && \
 *      docker compose -f docker-compose.stage.yml -p muhaven-stage \
 *        exec backend pnpm exec tsx scripts/seed-yield-bearing-overrides.ts'
 *
 * Idempotent — re-running rewrites the same value. Safe to re-execute
 * after each fresh ingest if you want to be paranoid.
 */
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../src/infrastructure/repository/postgres/db.js';
import { tokenMetadata } from '../src/infrastructure/repository/postgres/schema.js';

const YIELD_BEARING_OVERRIDES: Array<{ ticker: string; override: boolean }> = [
  // rwa.xyz flags these as NOT yield-bearing; MuHaven surfaces them as
  // yield-bearing because they all have meaningful APY data and our
  // demo narrative treats "earns APY" as the user-visible signal.
  { ticker: 'CETES', override: true },
  { ticker: 'EUTBL', override: true },
  { ticker: 'syrupUSDC', override: true },
  { ticker: 'ONyc', override: true },
  // USYC / BUIDL / USDY are already true on the raw rwa.xyz flag —
  // no override needed for them.
];

async function main(): Promise<void> {
  const db = getDb();
  const tickers = YIELD_BEARING_OVERRIDES.map((o) => o.ticker);

  // Pre-flight: surface any ticker that doesn't exist in the catalog
  // before we issue UPDATEs. A missing ticker is the most common
  // failure mode after a fresh deploy (forgot to run the ingest, or a
  // ticker was renamed upstream).
  const present = await db
    .select({ ticker: tokenMetadata.ticker })
    .from(tokenMetadata)
    .where(inArray(tokenMetadata.ticker, tickers));
  const presentSet = new Set(present.map((r) => r.ticker));
  const missing = tickers.filter((t) => !presentSet.has(t));
  if (missing.length > 0) {
    console.error(`Missing tickers in token_metadata: ${missing.join(', ')}`);
    console.error(
      'Run the oracle ingest first (`pnpm exec tsx scripts/ingest-oracle.ts`).',
    );
    process.exit(1);
  }

  // Single transaction so a mid-loop crash leaves no partial state.
  // `.returning()` reports per-row whether a row actually changed, so
  // a re-run shows operator-meaningful output (`noop` vs `updated`).
  let updated = 0;
  let noop = 0;
  await db.transaction(async (tx) => {
    for (const { ticker, override } of YIELD_BEARING_OVERRIDES) {
      const result = await tx
        .update(tokenMetadata)
        .set({ isYieldBearingOverride: override, updatedAt: new Date() })
        .where(eq(tokenMetadata.ticker, ticker))
        .returning({
          ticker: tokenMetadata.ticker,
          before: tokenMetadata.isYieldBearingOverride,
        });
      // `.returning` runs AFTER the SET, so `before` here actually
      // reflects the post-update value. We can't cheaply detect "no
      // change" without a separate SELECT; treat any row touched by
      // the UPDATE as `updated`. The output is still operator-clear.
      if (result.length > 0) {
        updated += 1;
        console.log(`  set is_yield_bearing_override=${override} for ${ticker}`);
      } else {
        noop += 1;
        console.log(`  WARN: no row updated for ${ticker} (already missing from pre-flight?)`);
      }
    }
  });
  console.log(
    `[seed-yield-overrides] applied ${updated} update(s), ${noop} no-op(s)`,
  );
}

main().catch((err) => {
  console.error('[seed-yield-overrides] uncaught:', err);
  process.exit(1);
});
