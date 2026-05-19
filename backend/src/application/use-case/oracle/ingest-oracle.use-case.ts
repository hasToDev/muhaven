import { randomUUID } from 'node:crypto';
import type { IOracleRepository } from '../../../domain/oracle/repository/oracle.repository.js';
import type {
  OracleMetadataUpsert,
  OracleSnapshotUpsert,
  OracleTimeseriesPoint,
} from '../../../domain/oracle/model/oracle-payload.js';
import {
  type OracleAssetPayload,
  type OracleIngestPerTokenResult,
  type OracleIngestResponse,
} from '../../dto/oracle/oracle-ingest.dto.js';

/**
 * Wave 5 Q1 — RWA oracle ingest pipeline.
 *
 * Reads the per-asset payload written by
 * `development/ORACLE_DATA_MINE/scripts/extract-asset.ts` and lands it
 * in three tables:
 *   1. `token_metadata`   — UPSERT keyed on (ticker)
 *   2. `oracle_snapshots` — INSERT (append-only point-in-time)
 *   3. `oracle_timeseries`— UPSERT keyed on (ticker, measure_slug, date)
 *
 * Per-asset failures DO NOT abort the batch — each result lands in the
 * response with its own status. The operator script can re-run with
 * just the failing tickers without losing the partial progress.
 *
 * Idempotency: re-running an identical payload is a no-op aside from
 * `oracle_snapshots` (which gains a fresh row per call — that's
 * intentional, snapshots are point-in-time and used for rolling charts).
 * If the operator wants strict idempotence on a re-run, that's a
 * separate decision; for now the snapshot ledger grows monotonically.
 */
export class IngestOracleUseCase {
  constructor(private readonly oracleRepo: IOracleRepository) {}

  async execute(assets: OracleAssetPayload[]): Promise<OracleIngestResponse> {
    const results: OracleIngestPerTokenResult[] = [];
    let timeseriesPointsTotal = 0;

    for (const asset of assets) {
      const result = await this.ingestOne(asset);
      results.push(result);
      timeseriesPointsTotal += result.timeseriesPointsUpserted ?? 0;
    }

    return {
      results,
      summary: {
        ok: results.filter((r) => r.status === 'ok').length,
        skipped: results.filter((r) => r.status === 'skipped').length,
        error: results.filter((r) => r.status === 'error').length,
        timeseriesPointsTotal,
      },
    };
  }

  private async ingestOne(
    asset: OracleAssetPayload,
  ): Promise<OracleIngestPerTokenResult> {
    const ticker = asset.ticker;
    try {
      const metadata = this.toMetadata(asset);
      await this.oracleRepo.upsertMetadata(metadata);

      const snapshot = this.toSnapshot(asset);
      let snapshotInserted = false;
      if (snapshot) {
        await this.oracleRepo.insertSnapshot(snapshot);
        snapshotInserted = true;
      }

      const points = this.toTimeseriesPoints(asset);
      if (points.length > 0) {
        await this.oracleRepo.upsertTimeseries(points);
      }

      return {
        ticker,
        status: 'ok',
        metadataUpserted: true,
        snapshotInserted,
        timeseriesPointsUpserted: points.length,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ticker, status: 'error', reason };
    }
  }

  private toMetadata(asset: OracleAssetPayload): OracleMetadataUpsert {
    const ticker = asset.ticker;
    const displayName = asset.title ?? ticker;

    // Decimal-as-string conversions — numeric Postgres columns accept
    // string-form decimals, which keeps full precision without the
    // 64-bit float → text round-trip ambiguity.
    const pmMin = asset.primaryMarket?.subscription_minimum_amount;

    return {
      ticker,
      rwaxyzAssetId: asset.source?.rwaxyzAssetId,
      rwaxyzSlug: asset.source?.rwaxyzSlug,
      sourceUrl: asset.source?.url,
      displayName,
      description: asset.description ?? undefined,
      iconUrl: asset.iconUrl ?? undefined,
      colorHex: asset.colorHex ?? undefined,
      website: asset.website ?? undefined,
      isYieldBearing: asset.isYieldBearing,
      distributesIncome: asset.distributesIncome ?? undefined,
      assetClassSlug: asset.assetClass?.slug,
      assetClassName: asset.assetClass?.name,
      issuerName: asset.issuer?.name,
      issuerLegalName: asset.issuer?.legal_name,
      issuerLei: asset.issuer?.lei ?? undefined,
      issuerCountry: asset.issuer?.legal_structure_country ?? undefined,
      managerName: asset.manager?.name,
      jurisdictionCountry: asset.jurisdiction?.country ?? undefined,
      regulatoryFramework: asset.jurisdiction?.regulatoryFramework ?? undefined,
      governingBody: asset.jurisdiction?.governingBody ?? undefined,
      legalStructure: asset.jurisdiction?.legalStructure ?? undefined,
      inceptionDate: asset.inceptionDate ?? undefined,
      feeManagementBps: asset.fees?.managementBps ?? undefined,
      feePerformanceBps: asset.fees?.performanceBps ?? undefined,
      feeStructureDescription: asset.fees?.structureDescription ?? undefined,
      pmSubscriptionFrequency: asset.primaryMarket?.subscription_frequency ?? undefined,
      pmSubscriptionMinimumDollar:
        typeof pmMin === 'number' ? String(pmMin) : undefined,
      pmRedemptionFrequency: asset.primaryMarket?.redemption_frequency ?? undefined,
      pmKycRequired: asset.primaryMarket?.kyc_is_required ?? undefined,
      underlyingTokens: asset.tokens?.map((t) => ({
        network: t.network,
        networkId: t.networkId,
        address: t.address,
        decimals: t.decimals,
        standards: t.standards,
      })),
      rawPayload: asset,
    };
  }

  private toSnapshot(asset: OracleAssetPayload): OracleSnapshotUpsert | null {
    // Skip the snapshot if neither aggregates nor marketData are present
    // — nothing to capture. The metadata row still upserts so cosmetic
    // refreshes (description / fees) don't bloat the snapshot ledger.
    const md = asset.marketData;
    if (!md && !asset.aggregates) return null;

    const yieldData = md?.yield;
    const valueData = md?.value;
    const supplyData = md?.supply;
    const holderData = md?.holders;

    // rwaxyzUpdatedAt is the source's last-recompute moment; snapshotAt
    // is when WE ingested it. They drift apart when the scraper batches
    // multiple assets across minutes.
    const rwaxyzUpdatedAtRaw = asset.source?.rwaxyzUpdatedAt;
    let rwaxyzUpdatedAt: Date | undefined;
    if (rwaxyzUpdatedAtRaw) {
      const d = new Date(rwaxyzUpdatedAtRaw);
      if (!Number.isNaN(d.getTime())) rwaxyzUpdatedAt = d;
    }

    return {
      id: randomUUID(),
      ticker: asset.ticker,
      snapshotAt: new Date(),
      source: 'rwaxyz_scrape',
      navDollar: numToStr(valueData?.net_asset_value_dollar?.val),
      priceDollar: numToStr(valueData?.price_dollar?.val),
      apy7Day: numToStr(yieldData?.apy_7_day?.val),
      apy30Day: numToStr(yieldData?.apy_30_day?.val),
      dailyYieldRate: numToStr(yieldData?.daily_yield_rate?.val),
      yieldToMaturityPercent: numToStr(yieldData?.yield_to_maturity_percent?.val),
      dailyYieldDistributedDollar: numToStr(
        yieldData?.daily_yield_distributed_dollar?.val,
      ),
      hypothetical10kPerformance: numToStr(
        yieldData?.hypothetical_10_000_performance?.val,
      ),
      totalSupplyToken: numToStr(supplyData?.total_supply_token?.val),
      totalAssetValueDollar: numToStr(valueData?.total_asset_value_dollar?.val),
      marketValueDollar: numToStr(valueData?.market_value_dollar?.val),
      holdingAddressesCount: numToInt(holderData?.holding_addresses_count?.val),
      top5HolderConcentration: numToStr(holderData?.top_5_holder_concentration?.val),
      rwaxyzUpdatedAt,
    };
  }

  private toTimeseriesPoints(
    asset: OracleAssetPayload,
  ): OracleTimeseriesPoint[] {
    if (!asset.timeseries) return [];
    const ticker = asset.ticker;

    // Each (measure_slug, date) key collapses to a single stored value
    // because `oracle_timeseries`'s PK is (ticker, measure_slug, date).
    // rwa.xyz ships per-network groups for some measures
    // (`bridged_token_value_dollar` etc.) where the aggregate function
    // is `sum` — those rows must be summed across groups to produce the
    // asset-level total the chart consumes. Single-group measures
    // (`apy_7_day`, `net_asset_value_dollar`, …) collapse to the only
    // value present. We sum unconditionally: it's a no-op when there's
    // only one group, and correct for sum-grouped measures. Non-sum
    // aggregate functions (`max`, `mean`, …) are not used by any
    // measure we currently chart — if rwa.xyz introduces one we'd
    // need a per-measure rule here.
    const aggregated = new Map<string, { value: number; unit?: string }>();

    for (const [measureSlug, payload] of Object.entries(asset.timeseries)) {
      const unit = payload.measure?.unit;
      for (const group of payload.groups) {
        for (const point of group.points) {
          const [date, value] = point;
          if (!isIsoDate(date) || typeof value !== 'number' || !Number.isFinite(value)) {
            continue;
          }
          const key = `${measureSlug}|${date}`;
          const existing = aggregated.get(key);
          if (existing) {
            existing.value += value;
          } else {
            aggregated.set(key, { value, unit });
          }
        }
      }
    }

    const out: OracleTimeseriesPoint[] = [];
    for (const [key, { value, unit }] of aggregated.entries()) {
      const sepAt = key.indexOf('|');
      const measureSlug = key.slice(0, sepAt);
      const date = key.slice(sepAt + 1);
      out.push({ ticker, measureSlug, date, value: String(value), unit });
    }
    return out;
  }
}

function numToStr(v: number | null | undefined): string | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return String(v);
}

function numToInt(v: number | null | undefined): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.trunc(v);
}

function isIsoDate(s: string): boolean {
  // Cheap shape check — accept `YYYY-MM-DD`; reject anything else so we
  // can't accidentally insert "2026-01-01T00:00:00Z" into the date
  // column.
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
