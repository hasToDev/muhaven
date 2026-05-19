import type {
  OracleSnapshotRead,
  OracleTimeseriesReadPoint,
  OracleUnderlyingToken,
  TokenListItem,
  TokenMetadataRead,
} from '../../../domain/oracle/model/oracle-payload.js';

/**
 * Wave 5 Q1 — wire shapes returned by the oracle read endpoints.
 *
 * Snake-case to match the rest of the public API surface (the existing
 * `/tokens` + `/portfolio` endpoints all use snake_case keys). Numeric
 * fields stay as strings to preserve `numeric(N,M)` precision across
 * JSON (IEEE-754 would lose digits on 18-decimal supply values).
 *
 * The mappers live here, not in the use-case files, so adding a column
 * is a one-line change at the domain shape + one-line change at the
 * mapper rather than scattered across three use cases.
 */

export interface TokenMetadataDto {
  ticker: string;
  display_name: string;
  description: string | null;
  icon_url: string | null;
  color_hex: string | null;
  website: string | null;
  is_yield_bearing: boolean;
  is_yield_bearing_rwaxyz: boolean;
  distributes_income: boolean | null;
  asset_class_slug: string | null;
  asset_class_name: string | null;
  issuer_name: string | null;
  issuer_legal_name: string | null;
  issuer_lei: string | null;
  issuer_country: string | null;
  manager_name: string | null;
  jurisdiction_country: string | null;
  regulatory_framework: string | null;
  governing_body: string | null;
  legal_structure: string | null;
  inception_date: string | null;
  fee_management_bps: number | null;
  fee_performance_bps: number | null;
  fee_structure_description: string | null;
  pm_subscription_frequency: string | null;
  pm_subscription_minimum_dollar: string | null;
  pm_redemption_frequency: string | null;
  pm_kyc_required: boolean | null;
  underlying_tokens: Array<{
    network: string;
    network_id: number | null;
    address: string;
    decimals: number;
    standards: string[] | null;
  }> | null;
  last_refreshed_at: string;
}

export interface OracleSnapshotDto {
  ticker: string;
  snapshot_at: string;
  source: string;
  nav_dollar: string | null;
  price_dollar: string | null;
  apy_7_day: string | null;
  apy_30_day: string | null;
  daily_yield_rate: string | null;
  yield_to_maturity_percent: string | null;
  daily_yield_distributed_dollar: string | null;
  hypothetical_10k_performance: string | null;
  total_supply_token: string | null;
  total_asset_value_dollar: string | null;
  market_value_dollar: string | null;
  holding_addresses_count: number | null;
  top_5_holder_concentration: string | null;
  rwaxyz_updated_at: string | null;
}

export interface OracleTimeseriesDto {
  ticker: string;
  measure_slug: string;
  from: string | null;
  to: string | null;
  count: number;
  points: Array<{ date: string; value: string; unit: string | null }>;
}

export function toTokenMetadataDto(meta: TokenMetadataRead): TokenMetadataDto {
  return {
    ticker: meta.ticker,
    display_name: meta.displayName,
    description: meta.description,
    icon_url: meta.iconUrl,
    color_hex: meta.colorHex,
    website: meta.website,
    is_yield_bearing: meta.isYieldBearing,
    is_yield_bearing_rwaxyz: meta.isYieldBearingRwaxyz,
    distributes_income: meta.distributesIncome,
    asset_class_slug: meta.assetClassSlug,
    asset_class_name: meta.assetClassName,
    issuer_name: meta.issuerName,
    issuer_legal_name: meta.issuerLegalName,
    issuer_lei: meta.issuerLei,
    issuer_country: meta.issuerCountry,
    manager_name: meta.managerName,
    jurisdiction_country: meta.jurisdictionCountry,
    regulatory_framework: meta.regulatoryFramework,
    governing_body: meta.governingBody,
    legal_structure: meta.legalStructure,
    inception_date: meta.inceptionDate,
    fee_management_bps: meta.feeManagementBps,
    fee_performance_bps: meta.feePerformanceBps,
    fee_structure_description: meta.feeStructureDescription,
    pm_subscription_frequency: meta.pmSubscriptionFrequency,
    pm_subscription_minimum_dollar: meta.pmSubscriptionMinimumDollar,
    pm_redemption_frequency: meta.pmRedemptionFrequency,
    pm_kyc_required: meta.pmKycRequired,
    underlying_tokens: meta.underlyingTokens?.map(toUnderlyingTokenDto) ?? null,
    last_refreshed_at: meta.lastRefreshedAt.toISOString(),
  };
}

function toUnderlyingTokenDto(t: OracleUnderlyingToken): {
  network: string;
  network_id: number | null;
  address: string;
  decimals: number;
  standards: string[] | null;
} {
  return {
    network: t.network,
    network_id: t.networkId ?? null,
    address: t.address,
    decimals: t.decimals,
    standards: t.standards ?? null,
  };
}

export function toOracleSnapshotDto(snap: OracleSnapshotRead): OracleSnapshotDto {
  return {
    ticker: snap.ticker,
    snapshot_at: snap.snapshotAt.toISOString(),
    source: snap.source,
    nav_dollar: snap.navDollar,
    price_dollar: snap.priceDollar,
    apy_7_day: snap.apy7Day,
    apy_30_day: snap.apy30Day,
    daily_yield_rate: snap.dailyYieldRate,
    yield_to_maturity_percent: snap.yieldToMaturityPercent,
    daily_yield_distributed_dollar: snap.dailyYieldDistributedDollar,
    hypothetical_10k_performance: snap.hypothetical10kPerformance,
    total_supply_token: snap.totalSupplyToken,
    total_asset_value_dollar: snap.totalAssetValueDollar,
    market_value_dollar: snap.marketValueDollar,
    holding_addresses_count: snap.holdingAddressesCount,
    top_5_holder_concentration: snap.top5HolderConcentration,
    rwaxyz_updated_at: snap.rwaxyzUpdatedAt?.toISOString() ?? null,
  };
}

export interface TokenListItemDto {
  ticker: string;
  display_name: string;
  description: string | null;
  icon_url: string | null;
  color_hex: string | null;
  is_yield_bearing: boolean;
  is_yield_bearing_rwaxyz: boolean;
  asset_class_slug: string | null;
  asset_class_name: string | null;
  issuer_name: string | null;
  issuer_country: string | null;
  pm_subscription_minimum_dollar: string | null;
  pm_subscription_frequency: string | null;
  inception_date: string | null;
  last_refreshed_at: string;
  latest_snapshot: {
    snapshot_at: string;
    nav_dollar: string | null;
    price_dollar: string | null;
    apy_7_day: string | null;
    total_asset_value_dollar: string | null;
    holding_addresses_count: number | null;
  } | null;
}

export interface TokenListDto {
  tokens: TokenListItemDto[];
}

export function toTokenListItemDto(item: TokenListItem): TokenListItemDto {
  return {
    ticker: item.ticker,
    display_name: item.displayName,
    description: item.description,
    icon_url: item.iconUrl,
    color_hex: item.colorHex,
    is_yield_bearing: item.isYieldBearing,
    is_yield_bearing_rwaxyz: item.isYieldBearingRwaxyz,
    asset_class_slug: item.assetClassSlug,
    asset_class_name: item.assetClassName,
    issuer_name: item.issuerName,
    issuer_country: item.issuerCountry,
    pm_subscription_minimum_dollar: item.pmSubscriptionMinimumDollar,
    pm_subscription_frequency: item.pmSubscriptionFrequency,
    inception_date: item.inceptionDate,
    last_refreshed_at: item.lastRefreshedAt.toISOString(),
    latest_snapshot: item.latestSnapshot
      ? {
          snapshot_at: item.latestSnapshot.snapshotAt.toISOString(),
          nav_dollar: item.latestSnapshot.navDollar,
          price_dollar: item.latestSnapshot.priceDollar,
          apy_7_day: item.latestSnapshot.apy7Day,
          total_asset_value_dollar: item.latestSnapshot.totalAssetValueDollar,
          holding_addresses_count: item.latestSnapshot.holdingAddressesCount,
        }
      : null,
  };
}

export function toOracleTimeseriesDto(
  ticker: string,
  measureSlug: string,
  from: string | null,
  to: string | null,
  points: OracleTimeseriesReadPoint[],
): OracleTimeseriesDto {
  return {
    ticker,
    measure_slug: measureSlug,
    from,
    to,
    count: points.length,
    points: points.map((p) => ({ date: p.date, value: p.value, unit: p.unit })),
  };
}
