import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { IOracleRepository } from '../../../domain/oracle/repository/oracle.repository.js';
import type {
  OracleAssetWrite,
  OracleMetadataUpsert,
  OracleSnapshotRead,
  OracleSnapshotUpsert,
  OracleTimeseriesPoint,
  OracleTimeseriesQuery,
  OracleTimeseriesReadPoint,
  OracleUnderlyingToken,
  TokenMetadataRead,
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

  async findMetadata(ticker: string): Promise<TokenMetadataRead | null> {
    const row = await this.db.query.tokenMetadata.findFirst({
      where: eq(tokenMetadata.ticker, ticker),
    });
    if (!row) return null;
    // Effective yield-bearing flag — `override ?? raw`. Drizzle types
    // the nullable boolean column as `boolean | null` (never
    // `undefined`) so the nullish-coalescing fallback is exhaustive.
    const effectiveYieldBearing =
      row.isYieldBearingOverride ?? row.isYieldBearing;
    return {
      ticker: row.ticker,
      displayName: row.displayName,
      description: row.description ?? null,
      iconUrl: row.iconUrl ?? null,
      colorHex: row.colorHex ?? null,
      website: row.website ?? null,
      isYieldBearing: effectiveYieldBearing,
      isYieldBearingRwaxyz: row.isYieldBearing,
      distributesIncome: row.distributesIncome ?? null,
      assetClassSlug: row.assetClassSlug ?? null,
      assetClassName: row.assetClassName ?? null,
      issuerName: row.issuerName ?? null,
      issuerLegalName: row.issuerLegalName ?? null,
      issuerLei: row.issuerLei ?? null,
      issuerCountry: row.issuerCountry ?? null,
      managerName: row.managerName ?? null,
      jurisdictionCountry: row.jurisdictionCountry ?? null,
      regulatoryFramework: row.regulatoryFramework ?? null,
      governingBody: row.governingBody ?? null,
      legalStructure: row.legalStructure ?? null,
      inceptionDate: row.inceptionDate ?? null,
      feeManagementBps: row.feeManagementBps ?? null,
      feePerformanceBps: row.feePerformanceBps ?? null,
      feeStructureDescription: row.feeStructureDescription ?? null,
      pmSubscriptionFrequency: row.pmSubscriptionFrequency ?? null,
      pmSubscriptionMinimumDollar: row.pmSubscriptionMinimumDollar ?? null,
      pmRedemptionFrequency: row.pmRedemptionFrequency ?? null,
      pmKycRequired: row.pmKycRequired ?? null,
      // `underlyingTokens` is stored as jsonb — Drizzle types it as
      // `unknown` so we cast through the domain shape. Safe because
      // the ingest path narrows to `OracleUnderlyingToken[]` before
      // insert.
      underlyingTokens: (row.underlyingTokens as OracleUnderlyingToken[] | null) ?? null,
      lastRefreshedAt: row.lastRefreshedAt,
    };
  }

  async findLatestSnapshot(ticker: string): Promise<OracleSnapshotRead | null> {
    const row = await this.db.query.oracleSnapshots.findFirst({
      where: eq(oracleSnapshots.ticker, ticker),
      orderBy: [desc(oracleSnapshots.snapshotAt)],
    });
    if (!row) return null;
    return {
      ticker: row.ticker,
      snapshotAt: row.snapshotAt,
      source: row.source,
      navDollar: row.navDollar ?? null,
      priceDollar: row.priceDollar ?? null,
      apy7Day: row.apy7Day ?? null,
      apy30Day: row.apy30Day ?? null,
      dailyYieldRate: row.dailyYieldRate ?? null,
      yieldToMaturityPercent: row.yieldToMaturityPercent ?? null,
      dailyYieldDistributedDollar: row.dailyYieldDistributedDollar ?? null,
      hypothetical10kPerformance: row.hypothetical10kPerformance ?? null,
      totalSupplyToken: row.totalSupplyToken ?? null,
      totalAssetValueDollar: row.totalAssetValueDollar ?? null,
      marketValueDollar: row.marketValueDollar ?? null,
      holdingAddressesCount: row.holdingAddressesCount ?? null,
      top5HolderConcentration: row.top5HolderConcentration ?? null,
      rwaxyzUpdatedAt: row.rwaxyzUpdatedAt ?? null,
    };
  }

  async hasTicker(ticker: string): Promise<boolean> {
    const row = await this.db
      .select({ ticker: tokenMetadata.ticker })
      .from(tokenMetadata)
      .where(eq(tokenMetadata.ticker, ticker))
      .limit(1);
    return row.length > 0;
  }

  async findTimeseries(
    query: OracleTimeseriesQuery,
  ): Promise<OracleTimeseriesReadPoint[]> {
    const conditions = [
      eq(oracleTimeseries.ticker, query.ticker),
      eq(oracleTimeseries.measureSlug, query.measureSlug),
    ];
    // `date` is a Postgres `date` column; Drizzle accepts `YYYY-MM-DD`
    // string operands and pushes them through as-is. The strict ISO
    // shape (+ real-calendar validation) is enforced at the route
    // layer before reaching here.
    if (query.from) conditions.push(gte(oracleTimeseries.date, query.from));
    if (query.to) conditions.push(lte(oracleTimeseries.date, query.to));

    // Caller-supplied `limit` cap — set by the use case to bound the
    // response size. Default 10,001 (one above the use-case ceiling) so
    // the use case can detect "would have exceeded" and 400-out vs
    // truncating silently.
    const rows = await this.db.query.oracleTimeseries.findMany({
      where: and(...conditions),
      orderBy: [asc(oracleTimeseries.date)],
      limit: query.limit,
    });
    return rows.map((r) => ({
      date: r.date,
      value: r.value,
      unit: r.unit ?? null,
    }));
  }
}

// Tx-scoped repo factored out so the transaction body stays thin and
// the SQL builders are testable in isolation. NOT exported — the
// transaction shape is the boundary, not the column list.
class PgOracleTxRepository {
  constructor(private readonly tx: Db) {}

  async upsertMetadata(input: OracleMetadataUpsert): Promise<void> {
    // Note: `is_yield_bearing_override` is intentionally NOT in this
    // shape. The ingest pipeline carries rwa.xyz's raw flag only;
    // the override is MuHaven's editorial decision set independently
    // (via `backend/scripts/seed-yield-bearing-overrides.ts`). Drizzle's
    // ON CONFLICT DO UPDATE only SETs the columns named in `set`, so
    // the override column survives every subsequent ingest — exactly
    // the semantic we want.
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
