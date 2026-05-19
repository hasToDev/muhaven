import { sql } from 'drizzle-orm';
import type { IOracleRepository } from '../../../domain/oracle/repository/oracle.repository.js';
import type {
  OracleAssetWrite,
  OracleMetadataUpsert,
  OracleSnapshotUpsert,
  OracleTimeseriesPoint,
} from '../../../domain/oracle/model/oracle-payload.js';
import {
  oracleSnapshots,
  oracleTimeseries,
  tokenMetadata,
} from './schema.js';
import type { Db } from './db.js';

// Postgres bind-param ceiling is 65,535 (int16). `oracle_timeseries`
// has 6 bindable columns per row (ticker, measure_slug, date, value,
// unit, updatedAt-sentinel) so 2,000 rows per flush keeps us at
// ~12,000 params — comfortable headroom under the cap.
const TIMESERIES_CHUNK = 2000;

export class PgOracleRepository implements IOracleRepository {
  constructor(private readonly db: Db) {}

  async ingestAsset(write: OracleAssetWrite): Promise<{
    metadataUpserted: boolean;
    snapshotInserted: boolean;
    timeseriesPointsUpserted: number;
  }> {
    // Single transaction across all three writes so a mid-chunk
    // timeseries failure rolls back metadata + snapshot too. The
    // returned status to the caller is therefore truthful.
    return this.db.transaction(async (tx) => {
      const txRepo = new PgOracleTxRepository(tx);

      await txRepo.upsertMetadata(write.metadata);
      const snapshotInserted = write.snapshot
        ? await txRepo.insertSnapshot(write.snapshot)
        : false;

      // Dedupe within a single payload so the INSERT … VALUES never
      // sees two rows with the same `(ticker, measure_slug, date)` —
      // Postgres rejects that with `21000 cardinality_violation`
      // ("ON CONFLICT DO UPDATE cannot affect row a second time").
      // The use case already dedupes, but a defense-in-depth here
      // means any future caller can't trigger the cardinality error.
      const dedupedPoints = dedupeTimeseries(write.timeseries);

      const timeseriesPointsUpserted = await txRepo.upsertTimeseries(dedupedPoints);

      return {
        metadataUpserted: true,
        snapshotInserted,
        timeseriesPointsUpserted,
      };
    });
  }
}

// Tx-scoped repo factored out so the transaction body stays thin and
// the SQL builders are testable in isolation. NOT exported — the
// transaction shape is the boundary, not the column list.
class PgOracleTxRepository {
  constructor(private readonly tx: Db) {}

  async upsertMetadata(input: OracleMetadataUpsert): Promise<void> {
    const now = new Date();
    const fields = {
      ticker: input.ticker,
      rwaxyzAssetId: input.rwaxyzAssetId,
      rwaxyzSlug: input.rwaxyzSlug,
      sourceUrl: input.sourceUrl,
      displayName: input.displayName,
      description: input.description,
      iconUrl: input.iconUrl,
      colorHex: input.colorHex,
      website: input.website,
      isYieldBearing: input.isYieldBearing,
      distributesIncome: input.distributesIncome,
      assetClassSlug: input.assetClassSlug,
      assetClassName: input.assetClassName,
      issuerName: input.issuerName,
      issuerLegalName: input.issuerLegalName,
      issuerLei: input.issuerLei,
      issuerCountry: input.issuerCountry,
      managerName: input.managerName,
      jurisdictionCountry: input.jurisdictionCountry,
      regulatoryFramework: input.regulatoryFramework,
      governingBody: input.governingBody,
      legalStructure: input.legalStructure,
      inceptionDate: input.inceptionDate,
      feeManagementBps: input.feeManagementBps,
      feePerformanceBps: input.feePerformanceBps,
      feeStructureDescription: input.feeStructureDescription,
      pmSubscriptionFrequency: input.pmSubscriptionFrequency,
      pmSubscriptionMinimumDollar: input.pmSubscriptionMinimumDollar,
      pmRedemptionFrequency: input.pmRedemptionFrequency,
      pmKycRequired: input.pmKycRequired,
      underlyingTokens: input.underlyingTokens,
    };

    await this.tx
      .insert(tokenMetadata)
      .values({
        ...fields,
        lastRefreshedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: tokenMetadata.ticker,
        // Re-stamp every display field + bump refresh markers. `created_at`
        // intentionally NOT in the set — first-seen survives rewrites.
        set: {
          ...fields,
          lastRefreshedAt: now,
          updatedAt: now,
        },
      });
  }

  async insertSnapshot(input: OracleSnapshotUpsert): Promise<boolean> {
    // Natural PK `(ticker, snapshot_at)` — same-microsecond retries
    // silently no-op via `onConflictDoNothing`. The `.returning()` call
    // tells us whether a row actually landed.
    const inserted = await this.tx
      .insert(oracleSnapshots)
      .values({
        ticker: input.ticker,
        snapshotAt: input.snapshotAt,
        source: input.source,
        navDollar: input.navDollar,
        priceDollar: input.priceDollar,
        apy7Day: input.apy7Day,
        apy30Day: input.apy30Day,
        dailyYieldRate: input.dailyYieldRate,
        yieldToMaturityPercent: input.yieldToMaturityPercent,
        dailyYieldDistributedDollar: input.dailyYieldDistributedDollar,
        hypothetical10kPerformance: input.hypothetical10kPerformance,
        totalSupplyToken: input.totalSupplyToken,
        totalAssetValueDollar: input.totalAssetValueDollar,
        marketValueDollar: input.marketValueDollar,
        holdingAddressesCount: input.holdingAddressesCount,
        top5HolderConcentration: input.top5HolderConcentration,
        rwaxyzUpdatedAt: input.rwaxyzUpdatedAt,
      })
      .onConflictDoNothing({
        target: [oracleSnapshots.ticker, oracleSnapshots.snapshotAt],
      })
      .returning({ ticker: oracleSnapshots.ticker });
    return inserted.length > 0;
  }

  async upsertTimeseries(points: OracleTimeseriesPoint[]): Promise<number> {
    if (points.length === 0) return 0;

    const now = new Date();
    let totalLanded = 0;

    for (let i = 0; i < points.length; i += TIMESERIES_CHUNK) {
      const chunk = points.slice(i, i + TIMESERIES_CHUNK);
      const landed = await this.tx
        .insert(oracleTimeseries)
        .values(
          chunk.map((p) => ({
            ticker: p.ticker,
            measureSlug: p.measureSlug,
            date: p.date,
            value: p.value,
            unit: p.unit,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [
            oracleTimeseries.ticker,
            oracleTimeseries.measureSlug,
            oracleTimeseries.date,
          ],
          // Re-stamp value + unit on conflict — rwa.xyz occasionally
          // back-corrects historical points. `created_at` survives
          // rewrites; `updated_at` records the back-correction moment
          // so a future operator can audit "what historical points
          // changed in the last refresh?".
          set: {
            value: sql`excluded.value`,
            unit: sql`excluded.unit`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .returning({ ticker: oracleTimeseries.ticker });
      totalLanded += landed.length;
    }

    return totalLanded;
  }
}

function dedupeTimeseries(
  points: OracleTimeseriesPoint[],
): OracleTimeseriesPoint[] {
  const seen = new Map<string, OracleTimeseriesPoint>();
  for (const p of points) {
    const key = `${p.ticker}${p.measureSlug}${p.date}`;
    seen.set(key, p);
  }
  return Array.from(seen.values());
}
