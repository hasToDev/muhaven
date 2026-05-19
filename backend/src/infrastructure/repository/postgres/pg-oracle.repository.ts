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
  TokenListItem,
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
    // Case-insensitive at the repo boundary — rwa.xyz tickers are
    // mixed-case (`syrupUSDC`, `MUon`), but consumers shouldn't have
    // to remember the canonical case. Mirrors the same pattern used
    // for addresses (see `feedback_address_case_at_repo_boundary`).
    // Cost is negligible at 11 rows + PK-bounded scan.
    const row = await this.db.query.tokenMetadata.findFirst({
      where: sql`lower(${tokenMetadata.ticker}) = lower(${ticker})`,
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
      where: sql`lower(${oracleSnapshots.ticker}) = lower(${ticker})`,
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

  async findMetadataList(): Promise<TokenListItem[]> {
    // Two parallel queries: card-shape metadata + DISTINCT ON
    // (ticker) ORDER BY snapshot_at DESC for the latest snapshot per
    // ticker. Merging in memory is cleaner than a single SQL join with
    // DISTINCT ON aggregation, and the catalog is bounded (~11 rows
    // today, designed up to hundreds).
    //
    // Drizzle's projection select keeps the wire payload small (~15
    // fields per row) — the marketplace card doesn't need the full
    // 30+ field metadata.
    const [metadataRows, latestRows] = await Promise.all([
      this.db
        .select({
          ticker: tokenMetadata.ticker,
          displayName: tokenMetadata.displayName,
          description: tokenMetadata.description,
          iconUrl: tokenMetadata.iconUrl,
          colorHex: tokenMetadata.colorHex,
          isYieldBearing: tokenMetadata.isYieldBearing,
          isYieldBearingOverride: tokenMetadata.isYieldBearingOverride,
          assetClassSlug: tokenMetadata.assetClassSlug,
          assetClassName: tokenMetadata.assetClassName,
          issuerName: tokenMetadata.issuerName,
          issuerCountry: tokenMetadata.issuerCountry,
          pmSubscriptionMinimumDollar: tokenMetadata.pmSubscriptionMinimumDollar,
          pmSubscriptionFrequency: tokenMetadata.pmSubscriptionFrequency,
          inceptionDate: tokenMetadata.inceptionDate,
          lastRefreshedAt: tokenMetadata.lastRefreshedAt,
        })
        .from(tokenMetadata)
        .orderBy(asc(tokenMetadata.ticker)),
      this.db.execute<{
        ticker: string;
        snapshot_at: Date | string;
        nav_dollar: string | null;
        price_dollar: string | null;
        apy_7_day: string | null;
        total_asset_value_dollar: string | null;
        holding_addresses_count: number | null;
      }>(sql`
        SELECT DISTINCT ON (ticker)
          ticker,
          snapshot_at,
          nav_dollar,
          price_dollar,
          apy_7_day,
          total_asset_value_dollar,
          holding_addresses_count
        FROM oracle_snapshots
        ORDER BY ticker, snapshot_at DESC
      `),
    ]);

    const latestByTicker = new Map<string, TokenListItem['latestSnapshot']>();
    // `db.execute` returns a `QueryResult` with rows on `.rows`. Column
    // names land snake_case verbatim (no Drizzle camelCase aliasing
    // on the raw-SQL path — see `pg-nav-history.repository.ts:73-85`
    // for the same pattern).
    for (const r of latestRows.rows) {
      latestByTicker.set(r.ticker, {
        snapshotAt:
          r.snapshot_at instanceof Date ? r.snapshot_at : new Date(r.snapshot_at),
        navDollar: r.nav_dollar,
        priceDollar: r.price_dollar,
        apy7Day: r.apy_7_day,
        totalAssetValueDollar: r.total_asset_value_dollar,
        holdingAddressesCount: r.holding_addresses_count,
      });
    }

    return metadataRows.map((m) => ({
      ticker: m.ticker,
      displayName: m.displayName,
      description: m.description ?? null,
      iconUrl: m.iconUrl ?? null,
      colorHex: m.colorHex ?? null,
      isYieldBearing: m.isYieldBearingOverride ?? m.isYieldBearing,
      isYieldBearingRwaxyz: m.isYieldBearing,
      assetClassSlug: m.assetClassSlug ?? null,
      assetClassName: m.assetClassName ?? null,
      issuerName: m.issuerName ?? null,
      issuerCountry: m.issuerCountry ?? null,
      pmSubscriptionMinimumDollar: m.pmSubscriptionMinimumDollar ?? null,
      pmSubscriptionFrequency: m.pmSubscriptionFrequency ?? null,
      inceptionDate: m.inceptionDate ?? null,
      lastRefreshedAt: m.lastRefreshedAt,
      latestSnapshot: latestByTicker.get(m.ticker) ?? null,
    }));
  }

  async findTimeseries(
    query: OracleTimeseriesQuery,
  ): Promise<OracleTimeseriesReadPoint[]> {
    const conditions = [
      sql`lower(${oracleTimeseries.ticker}) = lower(${query.ticker})`,
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
    // INVARIANT (load-bearing): `is_yield_bearing_override` MUST NOT
    // appear in `rwaxyzFields` below. The ingest pipeline carries
    // rwa.xyz's raw classification; the override is MuHaven's editorial
    // decision set independently by
    // `backend/scripts/seed-yield-bearing-overrides.ts`. Drizzle's
    // ON CONFLICT DO UPDATE only SETs the columns named in `set` —
    // omitting the override column here is what keeps the seed alive
    // across every subsequent refresh. The interface type
    // `OracleMetadataUpsert` (domain/oracle/model/oracle-payload.ts)
    // also doesn't carry the field, so adding `input.isYieldBearingOverride`
    // would be a TS error — defense in depth.
    const now = new Date();
    const rwaxyzFields = {
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
        ...rwaxyzFields,
        lastRefreshedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: tokenMetadata.ticker,
        // Re-stamp every display field + bump refresh markers. `created_at`
        // intentionally NOT in the set — first-seen survives rewrites.
        // `is_yield_bearing_override` intentionally NOT in `rwaxyzFields`
        // — see the INVARIANT note above.
        set: {
          ...rwaxyzFields,
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
