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
