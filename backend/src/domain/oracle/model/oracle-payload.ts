/**
 * Wave 5 Q1 — RWA oracle ingest input shapes.
 *
 * These are NOT domain entities — they're the typed write-payloads the
 * ingest pipeline hands to the repo. Domain entity classes (read shapes
 * for `TokenMetadata` / `OracleSnapshot` / `TimeseriesPoint`) land with
 * Q4's chart-read endpoints; this file stays write-only until then.
 *
 * The Zod input schema lives at
 * `application/dto/oracle/oracle-ingest.dto.ts` — keep field names in
 * sync between the two.
 */

export interface OracleUnderlyingToken {
  network: string;
  networkId?: number;
  address: string;
  decimals: number;
  standards?: string[];
}

export interface OracleTimeseriesPoint {
  ticker: string;
  measureSlug: string;
  date: string;
  value: string;
  unit?: string;
}

export interface OracleMetadataUpsert {
  ticker: string;
  rwaxyzAssetId?: number;
  rwaxyzSlug?: string;
  sourceUrl?: string;
  displayName: string;
  description?: string;
  iconUrl?: string;
  colorHex?: string;
  website?: string;
  isYieldBearing: boolean;
  distributesIncome?: boolean;
  assetClassSlug?: string;
  assetClassName?: string;
  issuerName?: string;
  issuerLegalName?: string;
  issuerLei?: string;
  issuerCountry?: string;
  managerName?: string;
  jurisdictionCountry?: string;
  regulatoryFramework?: string;
  governingBody?: string;
  legalStructure?: string;
  inceptionDate?: string;
  feeManagementBps?: number;
  feePerformanceBps?: number;
  feeStructureDescription?: string;
  pmSubscriptionFrequency?: string;
  pmSubscriptionMinimumDollar?: string;
  pmRedemptionFrequency?: string;
  pmKycRequired?: boolean;
  underlyingTokens?: OracleUnderlyingToken[];
}

export interface OracleSnapshotUpsert {
  ticker: string;
  snapshotAt: Date;
  source: string;
  navDollar?: string;
  priceDollar?: string;
  apy7Day?: string;
  apy30Day?: string;
  dailyYieldRate?: string;
  yieldToMaturityPercent?: string;
  dailyYieldDistributedDollar?: string;
  hypothetical10kPerformance?: string;
  totalSupplyToken?: string;
  totalAssetValueDollar?: string;
  marketValueDollar?: string;
  holdingAddressesCount?: number;
  top5HolderConcentration?: string;
  rwaxyzUpdatedAt?: Date;
}

/**
 * Atomic per-asset write — the use case bundles all three derived
 * shapes and the repo runs them inside a single Postgres transaction.
 * Previously the repo exposed three independent methods and a mid-
 * upsert failure on `upsertTimeseries` left metadata + snapshot
 * partially committed (returned status `error` but the caller had no
 * way to know what landed).
 */
export interface OracleAssetWrite {
  metadata: OracleMetadataUpsert;
  /** Null when the payload had no marketData / aggregates — metadata-only refresh. */
  snapshot: OracleSnapshotUpsert | null;
  timeseries: OracleTimeseriesPoint[];
}

// ── Read shapes (Wave 5 Q1 frontend / Q4 charts) ──────────────────────
//
// Pure data — no entity classes. The read endpoints serve the
// marketplace cards, token detail page, and chart components. The
// `is_yield_bearing` field returned to consumers is the EFFECTIVE
// value (`override ?? rwaxyz_flag`), not the raw column — the
// override semantic is implementation detail of the persistence layer.

export interface TokenMetadataRead {
  ticker: string;
  displayName: string;
  description: string | null;
  iconUrl: string | null;
  colorHex: string | null;
  website: string | null;
  /** Effective yield-bearing flag (override applied). */
  isYieldBearing: boolean;
  /** Raw rwa.xyz flag — exposed for transparency / debugging UIs. */
  isYieldBearingRwaxyz: boolean;
  distributesIncome: boolean | null;
  assetClassSlug: string | null;
  assetClassName: string | null;
  issuerName: string | null;
  issuerLegalName: string | null;
  issuerLei: string | null;
  issuerCountry: string | null;
  managerName: string | null;
  jurisdictionCountry: string | null;
  regulatoryFramework: string | null;
  governingBody: string | null;
  legalStructure: string | null;
  inceptionDate: string | null;
  feeManagementBps: number | null;
  feePerformanceBps: number | null;
  feeStructureDescription: string | null;
  pmSubscriptionFrequency: string | null;
  pmSubscriptionMinimumDollar: string | null;
  pmRedemptionFrequency: string | null;
  pmKycRequired: boolean | null;
  underlyingTokens: OracleUnderlyingToken[] | null;
  lastRefreshedAt: Date;
}

export interface OracleSnapshotRead {
  ticker: string;
  snapshotAt: Date;
  source: string;
  navDollar: string | null;
  priceDollar: string | null;
  apy7Day: string | null;
  apy30Day: string | null;
  dailyYieldRate: string | null;
  yieldToMaturityPercent: string | null;
  dailyYieldDistributedDollar: string | null;
  hypothetical10kPerformance: string | null;
  totalSupplyToken: string | null;
  totalAssetValueDollar: string | null;
  marketValueDollar: string | null;
  holdingAddressesCount: number | null;
  top5HolderConcentration: string | null;
  rwaxyzUpdatedAt: Date | null;
}

export interface OracleTimeseriesReadPoint {
  date: string;
  value: string;
  unit: string | null;
}

export interface OracleTimeseriesQuery {
  ticker: string;
  measureSlug: string;
  /** Inclusive lower bound. Null → from the earliest known point. */
  from?: string;
  /** Inclusive upper bound. Null → up to the latest known point. */
  to?: string;
  /**
   * Hard row cap. Use case passes `MAX_POINTS + 1` so it can detect
   * the "narrow the range" overflow without truncating silently.
   */
  limit?: number;
}

/**
 * Card-shape projection — what the marketplace list endpoint returns.
 * Subset of `TokenMetadataRead` (the fields a marketplace card
 * actually renders) plus the inline latest snapshot so the page can
 * fan out 1 list request instead of 11 × (metadata + snapshot).
 *
 * `latestSnapshot` is nullable because a metadata row may exist
 * without any snapshot yet (e.g. a token onboarded but the first
 * ingest snapshot hasn't landed). The frontend renders the static
 * fields and hides the hero scalars in that case.
 */
export interface TokenListItem {
  ticker: string;
  displayName: string;
  description: string | null;
  iconUrl: string | null;
  colorHex: string | null;
  isYieldBearing: boolean;
  isYieldBearingRwaxyz: boolean;
  assetClassSlug: string | null;
  assetClassName: string | null;
  issuerName: string | null;
  issuerCountry: string | null;
  pmSubscriptionMinimumDollar: string | null;
  pmSubscriptionFrequency: string | null;
  inceptionDate: string | null;
  lastRefreshedAt: Date;
  latestSnapshot: {
    snapshotAt: Date;
    navDollar: string | null;
    priceDollar: string | null;
    apy7Day: string | null;
    totalAssetValueDollar: string | null;
    holdingAddressesCount: number | null;
  } | null;
}
