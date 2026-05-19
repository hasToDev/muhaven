import { z } from 'zod';

/**
 * Wave 5 Q1 — RWA oracle ingest payload.
 *
 * Mirrors the JSON written by `development/ORACLE_DATA_MINE/scripts/
 * extract-asset.ts`. The schema is intentionally LOOSE — every numeric
 * field is `z.number()` (not int / not finite) because rwa.xyz mixes
 * percent decimals (0.0313), display percents (3.13), integer counts,
 * and dollar floats freely. We snapshot whatever they send and let the
 * frontend interpret per the documented `_units` block in the source
 * payload.
 *
 * Unknown extra fields pass through `.passthrough()` so a rwa.xyz wire-
 * format addition does NOT cause the entire batch to reject. The
 * `rawPayload` blob captures the full input verbatim for forward-compat.
 */

const numericPoint = z.tuple([z.string(), z.number()]);

const measureDescriptor = z
  .object({
    id: z.number().optional(),
    slug: z.string(),
    name: z.string().optional(),
    unit: z.string().optional(),
  })
  .passthrough();

const timeseriesGroup = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    type: z.string().optional(),
    name: z.string().optional(),
    color: z.string().optional(),
    points: z.array(numericPoint),
  })
  .passthrough();

const timeseriesMeasure = z
  .object({
    measure: measureDescriptor,
    aggregate: z.unknown().optional(),
    groups: z.array(timeseriesGroup),
  })
  .passthrough();

const issuerSchema = z
  .object({
    name: z.string().optional(),
    legal_name: z.string().optional(),
    lei: z.string().nullable().optional(),
    legal_structure_country: z.string().nullable().optional(),
  })
  .passthrough();

const managerSchema = z
  .object({
    name: z.string().optional(),
  })
  .passthrough();

const assetClassSchema = z
  .object({
    name: z.string().optional(),
    slug: z.string().optional(),
  })
  .passthrough();

const jurisdictionSchema = z
  .object({
    country: z.string().nullable().optional(),
    regulatoryFramework: z.string().nullable().optional(),
    governingBody: z.string().nullable().optional(),
    legalStructure: z.string().nullable().optional(),
    legalStructureCountry: z.string().nullable().optional(),
  })
  .passthrough();

const feesSchema = z
  .object({
    managementBps: z.number().nullable().optional(),
    performanceBps: z.number().nullable().optional(),
    structureDescription: z.string().nullable().optional(),
    otherDescription: z.string().nullable().optional(),
  })
  .passthrough();

const primaryMarketSchema = z
  .object({
    base_asset_ticker: z.string().nullable().optional(),
    kyc_is_required: z.boolean().nullable().optional(),
    subscription_frequency: z.string().nullable().optional(),
    subscription_minimum_amount: z.number().nullable().optional(),
    redemption_frequency: z.string().nullable().optional(),
  })
  .passthrough();

const underlyingTokenSchema = z
  .object({
    name: z.string().optional(),
    network: z.string(),
    networkId: z.number().optional(),
    address: z.string(),
    decimals: z.number(),
    standards: z.array(z.string()).optional(),
  })
  .passthrough();

const aggregateSchema = z
  .object({
    label: z.string(),
    type: z.string().optional(),
    value: z.number().nullable().optional(),
  })
  .passthrough();

const sourceSchema = z
  .object({
    url: z.string().optional(),
    rwaxyzAssetId: z.number().optional(),
    rwaxyzSlug: z.string().optional(),
    rwaxyzUpdatedAt: z.string().optional(),
  })
  .passthrough();

// A measure value-bundle (apy_7_day / net_asset_value_dollar / …) —
// `val` is the current scalar, `val_7d/30d/90d` are lookback comparisons.
// All optional because not every measure populates every interval.
const measureValueSchema = z
  .object({
    val: z.number().nullable().optional(),
  })
  .passthrough();

const marketDataYieldSchema = z
  .object({
    apy_7_day: measureValueSchema.optional(),
    apy_30_day: measureValueSchema.optional(),
    daily_yield_rate: measureValueSchema.optional(),
    yield_to_maturity_percent: measureValueSchema.optional(),
    daily_yield_distributed_dollar: measureValueSchema.optional(),
    hypothetical_10_000_performance: measureValueSchema.optional(),
  })
  .passthrough();

const marketDataSupplySchema = z
  .object({
    total_supply_token: measureValueSchema.optional(),
  })
  .passthrough();

const marketDataValueSchema = z
  .object({
    net_asset_value_dollar: measureValueSchema.optional(),
    price_dollar: measureValueSchema.optional(),
    total_asset_value_dollar: measureValueSchema.optional(),
    market_value_dollar: measureValueSchema.optional(),
  })
  .passthrough();

const marketDataHoldersSchema = z
  .object({
    holding_addresses_count: measureValueSchema.optional(),
    top_5_holder_concentration: measureValueSchema.optional(),
  })
  .passthrough();

const marketDataSchema = z
  .object({
    yield: marketDataYieldSchema.optional(),
    supply: marketDataSupplySchema.optional(),
    value: marketDataValueSchema.optional(),
    holders: marketDataHoldersSchema.optional(),
  })
  .passthrough();

export const OracleAssetPayloadSchema = z
  .object({
    // Identity — `ticker` is the PK in `token_metadata`; case is
    // preserved (rwa.xyz uses `syrupUSDC`, `MUon`, etc.).
    slug: z.string().min(1).max(64).optional(),
    ticker: z.string().min(1).max(32),
    title: z.string().min(1).max(256).optional(),
    description: z.string().nullable().optional(),
    website: z.string().nullable().optional(),
    iconUrl: z.string().nullable().optional(),
    colorHex: z.string().nullable().optional(),
    inceptionDate: z.string().nullable().optional(),

    isYieldBearing: z.boolean(),
    isOpenEnded: z.boolean().optional(),
    isInvestable: z.boolean().optional(),
    distributesIncome: z.boolean().nullable().optional(),

    issuer: issuerSchema.optional(),
    manager: managerSchema.nullable().optional(),
    assetClass: assetClassSchema.optional(),
    jurisdiction: jurisdictionSchema.optional(),
    fees: feesSchema.optional(),
    primaryMarket: primaryMarketSchema.optional(),
    tokens: z.array(underlyingTokenSchema).optional(),

    aggregates: z.array(aggregateSchema).optional(),
    marketData: marketDataSchema.optional(),
    timeseries: z.record(timeseriesMeasure).optional(),

    source: sourceSchema.optional(),

    scrapedAt: z.string().optional(),
  })
  .passthrough();

export const OracleIngestRequestSchema = z.object({
  // Single-shot ingest accepts an array of full per-asset payloads. The
  // operator script POSTs everything at once; the backend processes per
  // asset and returns per-token status.
  assets: z.array(OracleAssetPayloadSchema).min(1).max(64),
});

export type OracleAssetPayload = z.infer<typeof OracleAssetPayloadSchema>;
export type OracleIngestRequest = z.infer<typeof OracleIngestRequestSchema>;

export interface OracleIngestPerTokenResult {
  ticker: string;
  status: 'ok' | 'skipped' | 'error';
  reason?: string;
  metadataUpserted?: boolean;
  snapshotInserted?: boolean;
  timeseriesPointsUpserted?: number;
}

export interface OracleIngestResponse {
  results: OracleIngestPerTokenResult[];
  summary: {
    ok: number;
    skipped: number;
    error: number;
    timeseriesPointsTotal: number;
  };
}
