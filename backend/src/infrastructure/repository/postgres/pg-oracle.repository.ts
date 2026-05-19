import { sql } from 'drizzle-orm';
import type { IOracleRepository } from '../../../domain/oracle/repository/oracle.repository.js';
import type {
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

// Postgres default bind-param ceiling is 65,535; Drizzle does NOT
// auto-chunk multi-row VALUES inserts. `oracle_timeseries` has 5
// bindable columns per row (ticker, measure_slug, date, value, unit) →
// safely under 2,000 rows per flush keeps us at ~10,000 params and well
// inside Postgres' ceiling even when the column count grows.
const TIMESERIES_CHUNK = 2000;

export class PgOracleRepository implements IOracleRepository {
  constructor(private readonly db: Db) {}

  async upsertMetadata(input: OracleMetadataUpsert): Promise<void> {
    const now = new Date();
    await this.db
      .insert(tokenMetadata)
      .values({
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
        rawPayload: input.rawPayload,
        lastRefreshedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: tokenMetadata.ticker,
        set: {
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
          rawPayload: input.rawPayload,
          lastRefreshedAt: now,
          updatedAt: now,
        },
      });
  }

  async insertSnapshot(input: OracleSnapshotUpsert): Promise<void> {
    await this.db.insert(oracleSnapshots).values({
      id: input.id,
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
    });
  }

  async upsertTimeseries(points: OracleTimeseriesPoint[]): Promise<void> {
    if (points.length === 0) return;

    for (let i = 0; i < points.length; i += TIMESERIES_CHUNK) {
      const chunk = points.slice(i, i + TIMESERIES_CHUNK);
      await this.db
        .insert(oracleTimeseries)
        .values(
          chunk.map((p) => ({
            ticker: p.ticker,
            measureSlug: p.measureSlug,
            date: p.date,
            value: p.value,
            unit: p.unit,
          })),
        )
        .onConflictDoUpdate({
          target: [
            oracleTimeseries.ticker,
            oracleTimeseries.measureSlug,
            oracleTimeseries.date,
          ],
          // Re-stamp value + unit on conflict — rwa.xyz occasionally
          // back-corrects historical points. `created_at` is intentionally
          // NOT touched so the first-seen timestamp survives rewrites.
          set: {
            value: sql`excluded.value`,
            unit: sql`excluded.unit`,
          },
        });
    }
  }
}
