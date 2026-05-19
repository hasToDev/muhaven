import type { IOracleRepository } from '../../../domain/oracle/repository/oracle.repository.js';
import type {
  OracleAssetWrite,
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
 * in three tables via a single per-asset transaction:
 *   1. `token_metadata`   — UPSERT keyed on (ticker)
 *   2. `oracle_snapshots` — INSERT … ON CONFLICT DO NOTHING on natural
 *                            PK `(ticker, snapshot_at)`
 *   3. `oracle_timeseries`— UPSERT keyed on (ticker, measure_slug, date)
 *
 * Per-asset failures DO NOT abort the batch — each result lands in the
 * response with its own status. Within an asset, all three writes share
 * one transaction so a mid-chunk failure rolls everything back.
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
      const write: OracleAssetWrite = {
        metadata: this.toMetadata(asset),
        snapshot: this.toSnapshot(asset),
        timeseries: this.toTimeseriesPoints(asset),
      };

      const { metadataUpserted, snapshotInserted, timeseriesPointsUpserted } =
        await this.oracleRepo.ingestAsset(write);

      return {
        ticker,
        status: 'ok',
        metadataUpserted,
        snapshotInserted,
        timeseriesPointsUpserted,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ticker, status: 'error', reason };
    }
  }

  private toMetadata(asset: OracleAssetPayload): OracleMetadataUpsert {
    const ticker = asset.ticker;
    const displayName = asset.title ?? ticker;
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
      assetClassName: asset.assetClass?.name ?? undefined,
      issuerName: asset.issuer?.name ?? undefined,
      issuerLegalName: asset.issuer?.legal_name ?? undefined,
      issuerLei: asset.issuer?.lei ?? undefined,
      issuerCountry: asset.issuer?.legal_structure_country ?? undefined,
      managerName: asset.manager?.name ?? undefined,
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
    };
  }

  private toSnapshot(asset: OracleAssetPayload): OracleSnapshotUpsert | null {
    const md = asset.marketData;
    if (!md && !asset.aggregates) return null;

    const yieldData = md?.yield;
    const valueData = md?.value;
    const supplyData = md?.supply;
    const holderData = md?.holders;

    const rwaxyzUpdatedAtRaw = asset.source?.rwaxyzUpdatedAt;
    let rwaxyzUpdatedAt: Date | undefined;
    if (rwaxyzUpdatedAtRaw) {
      const d = new Date(rwaxyzUpdatedAtRaw);
      if (!Number.isNaN(d.getTime())) rwaxyzUpdatedAt = d;
    }

    return {
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
    // because the table PK is (ticker, measure_slug, date). For
    // measures with `aggregateFunction: sum` (e.g.
    // `bridged_token_value_dollar`) rwa.xyz ships per-network groups
    // that must be summed across groups to produce the asset-level
    // total the chart consumes. Single-group measures (`apy_7_day`,
    // `net_asset_value_dollar`, …) collapse to the only value
    // present.
    //
    // Group sort: deterministic numeric key so the float `+=`
    // accumulation order is stable across scrapes. rwa.xyz does NOT
    // guarantee group ordering between refreshes — without this sort
    // two ingests of "the same" payload could stringify to different
    // values (`0.3` vs `0.30000000000000004`), churn the DB on
    // upserts, and break idempotence claims. Sorting by `id` first
    // (numeric — rwa.xyz's stable network identifier) then `name`
    // (string — fallback) is robust across the rwa.xyz wire shapes
    // observed so far.
    const aggregated = new Map<string, { value: number; unit?: string }>();

    const measureKeys = Object.keys(asset.timeseries).sort();
    for (const measureSlug of measureKeys) {
      const payload = asset.timeseries[measureSlug]!;
      const unit = payload.measure?.unit;
      const groups = [...payload.groups].sort((a, b) => {
        const aId = typeof a.id === 'number' ? a.id : Number.MAX_SAFE_INTEGER;
        const bId = typeof b.id === 'number' ? b.id : Number.MAX_SAFE_INTEGER;
        if (aId !== bId) return aId - bId;
        return (a.name ?? '').localeCompare(b.name ?? '');
      });
      for (const group of groups) {
        for (const point of group.points) {
          const [date, value] = point;
          if (!isStrictIsoDate(date) || typeof value !== 'number' || !Number.isFinite(value)) {
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

/**
 * Real ISO-date validator (not just regex). Accepts strict
 * `YYYY-MM-DD` AND verifies the calendar — `2026-13-45` fails because
 * round-tripping through `Date` produces a different string. Regex-
 * only would silently accept impossible dates and Postgres' `date`
 * type would then reject the row, blowing up the entire chunk's
 * transaction.
 */
function isStrictIsoDate(s: string): boolean {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}
