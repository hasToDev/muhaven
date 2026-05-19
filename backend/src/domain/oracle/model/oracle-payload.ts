/**
 * Wave 5 Q1 — RWA oracle payload shape (rwa.xyz scrape format).
 *
 * Mirrors the JSON written by `development/ORACLE_DATA_MINE/scripts/
 * extract-asset.ts`. Only the fields the backend ingest path reads are
 * typed; the rest of the rwa.xyz payload is preserved in `rawPayload`
 * for forward-compat. The Zod schema lives at
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
  rawPayload?: unknown;
}

export interface OracleSnapshotUpsert {
  id: string;
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
