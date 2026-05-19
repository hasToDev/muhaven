import { z } from 'zod';

/**
 * Wave 5 Q1 — RWA oracle ingest payload.
 *
 * Mirrors the JSON written by `development/ORACLE_DATA_MINE/scripts/
 * extract-asset.ts`. Numeric leaf fields are `z.number()` (not int /
 * not finite) because rwa.xyz mixes percent decimals (0.0313), display
 * percents (3.13), integer counts, and dollar floats freely. The
 * frontend interprets per the documented `_units` block in the source
 * payload.
 *
 * Hardening from review pass 2 (2026-05-19):
 *  - Identifier fields (`ticker`, `measure_slug`) carry strict regex so
 *    they can't carry whitespace/newlines/quotes/`|` into PK semantics
 *    or LLM context strings.
 *  - Free-text display fields carry length caps so a poisoned scrape
 *    can't blow up the row size or land a multi-KB prompt-injection
 *    payload in `description` / `issuer_name` etc.
 *  - Array fields carry sane upper bounds — a single 64-asset batch
 *    with 4000 points × 50 groups × 50 measures would otherwise OOM
 *    the in-memory `aggregated` Map in the use case.
 *  - `.passthrough()` preserved on objects so unknown rwa.xyz fields
 *    don't reject the batch; the raw payload is NOT stored verbatim
 *    anymore (raw_payload column dropped — see review H3 / M2).
 */

// Identifiers — alphanumeric + a small set of safe separators. Must
// survive use as DB primary-key components AND as keys in LLM-visible
// JSON instructions. rwa.xyz tickers seen: `USYC`, `BUIDL`, `USDY`,
// `EUTBL`, `CETES`, `syrupUSDC`, `ONyc`, `STRCx`, `MUon`, `NVDAon`,
// `TSLAx` — all match `[A-Za-z0-9_-]{1,32}`. Measure slugs are
// snake_case: `apy_7_day`, `net_asset_value_dollar`,
// `bridged_token_value_dollar`.
const tickerSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const measureSlugSchema = z.string().regex(/^[a-z0-9_]{1,64}$/);

// Free-text display caps — `description` is the longest legitimate
// field on rwa.xyz, ~500 chars worst-case. 2000 gives runway without
// inviting prompt-injection payloads.
const shortText = z.string().max(256).nullable().optional();
const longText = z.string().max(2000).nullable().optional();
const isoDateText = z.string().max(64).nullable().optional();

const numericPoint = z.tuple([z.string().max(64), z.number()]);

const measureDescriptor = z
  .object({
    id: z.number().optional(),
    slug: z.string().max(64).optional(),
    name: z.string().max(256).optional(),
    unit: z.string().max(32).optional(),
  })
  .passthrough();

const timeseriesGroup = z
  .object({
    id: z.union([z.number(), z.string().max(64)]).optional(),
    type: z.string().max(64).optional(),
    name: z.string().max(256).optional(),
    color: z.string().max(32).optional(),
    points: z.array(numericPoint).max(4000),
  })
  .passthrough();

const timeseriesMeasure = z
  .object({
    measure: measureDescriptor,
    aggregate: z.unknown().optional(),
    groups: z.array(timeseriesGroup).max(20),
  })
  .passthrough();

const issuerSchema = z
  .object({
    name: shortText,
    legal_name: shortText,
    lei: shortText,
    legal_structure_country: shortText,
  })
  .passthrough();

const managerSchema = z
  .object({
    name: shortText,
  })
  .passthrough();

const assetClassSchema = z
  .object({
    name: shortText,
    slug: z.string().max(64).optional(),
  })
  .passthrough();

const jurisdictionSchema = z
  .object({
    country: shortText,
    regulatoryFramework: shortText,
    governingBody: shortText,
    legalStructure: shortText,
    legalStructureCountry: shortText,
  })
  .passthrough();

const feesSchema = z
  .object({
    managementBps: z.number().nullable().optional(),
    performanceBps: z.number().nullable().optional(),
    structureDescription: longText,
    otherDescription: longText,
  })
  .passthrough();

const primaryMarketSchema = z
  .object({
    base_asset_ticker: shortText,
    kyc_is_required: z.boolean().nullable().optional(),
    subscription_frequency: shortText,
    subscription_minimum_amount: z.number().nullable().optional(),
    redemption_frequency: shortText,
  })
  .passthrough();

const underlyingTokenSchema = z
  .object({
    name: z.string().max(256).optional(),
    network: z.string().max(64),
    networkId: z.number().optional(),
    address: z.string().max(128),
    decimals: z.number(),
    standards: z.array(z.string().max(32)).max(8).optional(),
  })
  .passthrough();

const aggregateSchema = z
  .object({
    label: z.string().max(128),
    type: z.string().max(32).optional(),
    value: z.number().nullable().optional(),
  })
  .passthrough();

const sourceSchema = z
  .object({
    url: z.string().max(512).optional(),
    rwaxyzAssetId: z.number().optional(),
    rwaxyzSlug: z.string().max(128).optional(),
    rwaxyzUpdatedAt: z.string().max(64).optional(),
  })
  .passthrough();

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

const timeseriesRecordSchema = z
  .record(measureSlugSchema, timeseriesMeasure)
  .refine((r) => Object.keys(r).length <= 64, {
    message: 'timeseries has more than 64 measures',
  });

export const OracleAssetPayloadSchema = z
  .object({
    slug: z.string().max(64).optional(),
    ticker: tickerSchema,
    title: z.string().max(256).optional(),
    description: longText,
    website: z.string().max(512).nullable().optional(),
    iconUrl: z.string().max(512).nullable().optional(),
    colorHex: z.string().max(16).nullable().optional(),
    inceptionDate: isoDateText,

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
    tokens: z.array(underlyingTokenSchema).max(20).optional(),

    aggregates: z.array(aggregateSchema).max(50).optional(),
    marketData: marketDataSchema.optional(),
    timeseries: timeseriesRecordSchema.optional(),

    source: sourceSchema.optional(),

    scrapedAt: z.string().max(64).optional(),
  })
  .passthrough();

export const OracleIngestRequestSchema = z.object({
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
