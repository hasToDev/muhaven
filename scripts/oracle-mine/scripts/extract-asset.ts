/**
 * Per-asset extractor.
 *
 * Pure parser — does NOT open a browser. Reads `_debug/<SLUG>.html`
 * (produced by `scrape-asset.ts`), pulls the embedded `__NEXT_DATA__`
 * blob + any decoded asset-scoped timeseries XHRs, and writes a clean
 * `data/<SLUG>.json` for downstream MuHaven code (oracle reference data).
 *
 * Usage: tsx scripts/extract-asset.ts --slug=<TICKER>
 *
 * Re-run any time the extraction shape changes — no browser round-trip
 * needed unless rwa.xyz updated its content.
 */
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeRwaXyzTrpc, extractTrpcData, isEncodedTrpcData } from './lib/rwaxyz-decode.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const XHR_DIR = path.join(ROOT, '_debug', 'xhr');

// Every market-data metric on rwa.xyz follows this shape.
// All fields nullable because some assets / metrics don't populate every window.
interface MetricSnapshot {
  val: number | null;
  val_7d: number | null;
  val_30d: number | null;
  val_90d: number | null;
  chg_7d_amt: number | null;
  chg_7d_pct: number | null;
  chg_30d_amt: number | null;
  chg_30d_pct: number | null;
  chg_90d_amt: number | null;
  chg_90d_pct: number | null;
}

// Grouped buckets for downstream consumers (matches what the
// rwa.xyz page visually groups together).
const METRIC_GROUPS = {
  yield: [
    'apy_7_day',
    'apy_30_day',
    'daily_yield_rate',
    'yield_to_maturity_percent',
    'daily_yield_distributed_dollar',
    'daily_yield_distributed_token',
    'hypothetical_10_000_performance',
    'cumulative_interest_earned_dollar',
    'cumulative_interest_earned_token',
  ],
  supply: [
    'total_supply_token',
    'circulating_supply_token',
    'raw_supply',
    'bridged_token_supply_token',
    'rebase_multiplier',
  ],
  value: [
    'total_asset_value_dollar',
    'market_value_dollar',
    'market_cap_dollar',
    'circulating_market_value_dollar',
    'circulating_asset_value_dollar',
    'net_asset_value_dollar',
    'net_asset_value_token',
    'price_dollar',
    'bridged_token_market_cap_dollar',
    'bridged_token_value_dollar',
  ],
  holders: [
    'holding_addresses_count',
    'adjusted_holding_addresses_count',
    'top_holder_concentration',
    'top_5_holder_concentration',
    'top_10_holder_concentration',
  ],
  activity: [
    'daily_active_addresses_count',
    'weekly_active_addresses_count',
    'monthly_active_addresses_count',
    'quarterly_active_addresses_count',
    'annually_active_addresses_count',
    'trailing_7_day_active_addresses_count',
    'trailing_30_day_active_addresses_count',
    'trailing_90_day_active_addresses_count',
    'trailing_365_day_active_addresses_count',
    'number_of_daily_transactions_count',
    'daily_transfer_volume_dollar',
    'daily_transfer_volume_token',
    'weekly_transfer_count',
    'weekly_transfer_volume',
    'monthly_transfer_count',
    'monthly_transfer_volume',
    'trailing_7_day_transfer_count',
    'trailing_7_day_transfer_volume',
    'trailing_30_day_transfer_count',
    'trailing_30_day_transfer_volume',
  ],
  mintsBurns: [
    'daily_mints_token',
    'daily_mints_dollar',
    'daily_burns_token',
    'daily_burns_dollar',
    'adjusted_daily_mints_token',
    'adjusted_daily_mints_dollar',
    'adjusted_daily_burns_token',
    'adjusted_daily_burns_dollar',
  ],
} as const satisfies Record<string, readonly string[]>;

/**
 * Extract one asset's data from `_debug/<slug>.html` (+ any matching
 * timeseries XHRs in `_debug/xhr/`) and write `data/<slug>.json`.
 *
 * Pure function — safe to call in a loop from `refresh-all.ts` without
 * spawning subprocesses. Throws on failure.
 */
export async function runExtract(slug: string): Promise<void> {
  const HTML_PATH = path.join(ROOT, '_debug', `${slug}.html`);
  const OUT_PATH = path.join(ROOT, 'data', `${slug}.json`);
  const SLUG = slug;
  const html = await fs.readFile(HTML_PATH, 'utf8');
  const next = extractNextData(html);

  const asset = next.props?.pageProps?.asset;
  if (!asset) throw new Error('No props.pageProps.asset in __NEXT_DATA__');
  if (typeof asset.id !== 'number') throw new Error(`asset.id is not a number (got ${typeof asset.id})`);
  const assetId: number = asset.id;

  const aggregates = next.props?.pageProps?.aggregates ?? [];

  const out = {
    slug: SLUG,
    scrapedAt: new Date().toISOString(),
    source: {
      url: `https://app.rwa.xyz/assets/${SLUG}`,
      rwaxyzAssetId: asset.id,
      rwaxyzSlug: asset.slug,
      rwaxyzUpdatedAt: asset._updated_at ?? null,
      nextBuildId: next.buildId ?? null,
    },
    title: asset.name ?? null,
    ticker: asset.ticker ?? null,
    description: asset.description ?? null,
    website: asset.website ?? null,
    iconUrl: asset.icon_url ?? null,
    colorHex: asset.color_hex ?? null,
    inceptionDate: asset.inception_date ?? null,
    isYieldBearing: asset.is_yield_bearing ?? null,
    isOpenEnded: asset.is_open_ended ?? null,
    isInvestable: asset.is_investable ?? null,
    distributesIncome: asset.distributes_income ?? null,
    issuer: pickEntity(asset.issuer, [
      'id',
      'name',
      'legal_name',
      'slug',
      'icon_url',
      'lei',
      'cik',
      'legal_structure_type',
      'legal_structure_country',
    ]),
    manager: pickEntity(asset.manager, [
      'id',
      'name',
      'legal_name',
      'slug',
      'website',
      'lei',
      'cik',
    ]),
    assetClass: pickEntity(asset.asset_class, ['id', 'name', 'slug']),
    jurisdiction: {
      country: asset.jurisdiction_country_name ?? null,
      regulatoryFramework: asset.regulatory_framework ?? null,
      governingBody: asset.governing_body ?? null,
      legalStructure: asset.legal_structure__description ?? null,
      legalStructureCountry: asset.legal_structure__country_name ?? null,
    },
    fees: {
      managementBps: asset.total_management_fee_bps ?? null,
      performanceBps: asset.total_performance_fee_bps ?? null,
      structureDescription: asset.fee_structure_description ?? null,
      otherDescription: asset.other_fees_description ?? null,
    },
    primaryMarket: pickEntity(asset.primary_market, [
      'base_asset_ticker',
      'kyc_is_required',
      'subscription_frequency',
      'subscription_description',
      'subscription_minimum_amount',
      'subscription_fee_bps',
      'redemption_frequency',
      'redemption_description',
      'redemption_minimum_amount',
      'redemption_fee_bps',
      'is_subscription_allowed',
      'is_redemption_allowed',
    ]),
    tokens: Array.isArray(asset.tokens)
      ? asset.tokens.map((t: Record<string, unknown>) => ({
          id: t.id,
          assetId: t.asset_id,
          name: t.name,
          network: t.network_name,
          networkId: t.network_id,
          address: t.address,
          decimals: t.decimals,
          standards: t.standards,
          transferabilityType: t.transferability_type,
          tokenizationType: t.tokenization_type,
          protocolName: t.protocol_name,
          hidden: t.hidden,
        }))
      : [],
    aggregates: Array.isArray(aggregates) ? aggregates : [],
    marketData: buildMarketData(asset),
    timeseries: {} as Record<string, TimeseriesResult>,
    apyHistory: null as null | TimeseriesResult,
    _units: {
      'aggregates[].value': {
        percent: 'decimal — multiply by 100 for display (0.0313 → 3.13%)',
        dollar: 'dollars (1.125 → $1.13)',
        count: 'integer (44 → 44)',
      },
      'marketData.yield.apy_7_day.val / apy_30_day.val': 'percent — display as-is (3.13 → 3.13%)',
      'marketData.yield.daily_yield_rate.val': 'percent — display as-is (~0.0085 → 0.0085%)',
      'marketData.yield.yield_to_maturity_percent.val': 'decimal — multiply by 100 (despite field name suffix)',
      'marketData.value.*_dollar.val': 'dollars',
      'marketData.value.*_token.val': 'tokens (human-readable units, NOT raw with decimals)',
      'marketData.supply.*_token.val': 'tokens (human-readable units)',
      'marketData.holders.holding_addresses_count.val': 'integer count',
      'marketData.holders.top_*_concentration.val': 'percent — values can exceed 100 due to source weighting; treat as advisory',
      'timeseries.<slug>.groups[].points': '[ISO date, numeric value]. Unit matches measure.unit.',
      'recommendation':
        'For canonical demo oracle values, prefer aggregates[] — types are tagged and the data is what rwa.xyz renders on hero cards. marketData.* fields carry richer trajectory (val_7d/30d/90d) but units are inconsistent — verify per field before consuming.',
    } as Record<string, unknown>,
    _notes: [
      'Round-3 extraction. Pulled from __NEXT_DATA__ (SSR payload) plus any',
      'captured /api/trpc/tokenTimeseries.queryTimeseries XHRs filtered to this',
      'asset (asset_id=51).',
      '',
      'tRPC bulk-query responses use a custom wire format:',
      '  base64( 15_byte_salt || gzip( REVERSE( JSON ) ) || optional_garbage )',
      'See scripts/lib/rwaxyz-decode.ts for the decoder.',
      '',
      'apyHistory is populated only if an apy_7_day or apy_30_day series was',
      'captured (the page must have rendered an APY chart while scraping). If',
      'null, click into the APY chart on rwa.xyz before pressing Enter in the',
      'scraper, or run `npm run fetch:timeseries` to probe the API directly.',
    ].join('\n'),
  };

  // Decode any captured timeseries XHRs (asset-scoped only) and embed.
  out.timeseries = await loadDecodedTimeseries(assetId);
  // Lift APY series into the top-level apyHistory if either was captured.
  out.apyHistory =
    out.timeseries.apy_7_day ?? out.timeseries.apy_30_day ?? null;

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${path.relative(ROOT, OUT_PATH)}`);
  console.log(`  title:      ${out.title}`);
  console.log(`  ticker:     ${out.ticker}`);
  console.log(`  issuer:     ${out.issuer?.name ?? '<none>'}`);
  console.log(`  assetClass: ${out.assetClass?.name ?? '<none>'}`);
  console.log(`  tokens:     ${out.tokens.length} on-chain contract(s)`);
  console.log(`  aggregates: ${out.aggregates.length} hero card(s)`);
  const yieldKeys = Object.keys(out.marketData.yield);
  console.log(`  metrics:    yield=${yieldKeys.length}, value=${Object.keys(out.marketData.value).length}, supply=${Object.keys(out.marketData.supply).length}`);
  const apy7 = out.marketData.yield.apy_7_day;
  if (apy7?.val != null) {
    // asset.apy_7_day.val is already in percent units — display as-is.
    const fmt = (n: number | null) => (n == null ? '?' : n.toFixed(2) + '%');
    console.log(
      `  apy_7_day:  ${fmt(apy7.val)} (val_30d=${fmt(apy7.val_30d)}, val_90d=${fmt(apy7.val_90d)})`,
    );
  }
  const aggApy = (out.aggregates as Array<{ label?: string; value?: number; type?: string }>).find(
    (a) => /apy/i.test(a.label ?? ''),
  );
  if (aggApy) {
    // aggregates[].value with type=percent is decimal — multiply by 100 for display.
    console.log(
      `  hero APY:   ${aggApy.value != null ? (aggApy.value * 100).toFixed(2) + '%' : '?'} (label="${aggApy.label}", type=${aggApy.type})`,
    );
  }
  const tsSlugs = Object.keys(out.timeseries);
  if (tsSlugs.length) {
    console.log(`  timeseries: ${tsSlugs.length} series decoded:`);
    for (const slug of tsSlugs) {
      const t = out.timeseries[slug];
      console.log(
        `    - ${slug.padEnd(36)} ${t.summary.groupCount} groups, ${t.summary.pointCount} pts, ${t.summary.from} → ${t.summary.to}  (unit=${t.measure.unit})`,
      );
    }
  } else {
    console.log('  timeseries: none captured (run scrape with APY chart visible to populate)');
  }
  console.log(
    `  apyHistory: ${out.apyHistory ? `${out.apyHistory.measure.slug} (${out.apyHistory.summary.pointCount} pts)` : 'null — APY chart XHR not captured yet'}`,
  );
}

interface TimeseriesGroup {
  id: number | string | null;
  type: string | null;
  name: string | null;
  color: string | null;
  points: Array<[string, number | null]>;
}

interface TimeseriesResult {
  measure: {
    id: number | null;
    slug: string;
    name: string;
    unit: string | null;
    description?: string | null;
  };
  aggregate: {
    groupBy: string | null;
    interval: string | null;
    aggregateFunction: string | null;
  };
  groups: TimeseriesGroup[];
  summary: {
    from: string | null;
    to: string | null;
    pointCount: number;
    groupCount: number;
  };
  capturedFrom: string;
}

/**
 * Scan `_debug/xhr/` for timeseries responses filtered on `assetId`. Decode
 * each via lib/rwaxyz-decode, normalize into a `{ measure_slug: TimeseriesResult }`
 * map, and also dump each decoded payload to `_debug/decoded/` for inspection.
 *
 * `assetId` comes from __NEXT_DATA__.props.pageProps.asset.id at runtime — it
 * is NOT the slug. For USYC the id is 51; for NVDAon / TSLAx etc. it's different.
 */
async function loadDecodedTimeseries(assetId: number): Promise<Record<string, TimeseriesResult>> {
  const out: Record<string, TimeseriesResult> = {};
  if (!fsSync.existsSync(XHR_DIR)) return out;

  const decodedDir = path.join(ROOT, '_debug', 'decoded');
  await fs.mkdir(decodedDir, { recursive: true });

  // rwa.xyz exposes TWO timeseries endpoints:
  //   - tokenTimeseries.queryTimeseries      — token-level (per-network), uses `measure_id`
  //   - assetTimeseriesV4.queryTimeseries    — asset-level (groupBy=asset), uses `measure_slug`
  // The APY chart on the asset page uses the latter. Scan both.
  const xhrFiles = (await fs.readdir(XHR_DIR)).filter(
    (f) =>
      f.includes('tokenTimeseries.queryTimeseries') ||
      f.includes('assetTimeseriesV4.queryTimeseries'),
  );

  // De-dupe by decoded measure_slug + groupBy — same query captured across
  // multiple scrape runs would otherwise overwrite each other inconsistently.
  const seenByKey = new Map<string, { mtime: number; payload: unknown; file: string }>();

  for (const f of xhrFiles) {
    const full = path.join(XHR_DIR, f);

    let body: unknown;
    try {
      body = JSON.parse(await fs.readFile(full, 'utf8'));
    } catch {
      continue;
    }

    let dataField: unknown;
    try {
      dataField = extractTrpcData(body);
    } catch {
      continue;
    }
    if (!isEncodedTrpcData(dataField)) continue;

    let payload: unknown;
    try {
      payload = decodeRwaXyzTrpc(dataField);
    } catch (e) {
      console.warn(`  decode failed for ${f}: ${(e as Error).message}`);
      continue;
    }

    const p = payload as {
      results?: Array<{
        measure?: { slug?: string };
        group?: { type?: string };
      }>;
      aggregate?: { groupBy?: string };
      filter?: {
        filters?: Array<{ field?: string; operator?: string; value?: unknown }>;
      };
    };

    // Filter to series that include this asset (asset_id=51). The decoded
    // payload echoes the original filter from the request.
    const filters = p.filter?.filters ?? [];
    const isAssetScoped = filters.some(
      (x) => x.field === 'asset_id' && x.operator === 'equals' && x.value === assetId,
    );
    if (!isAssetScoped) continue;

    const slug = p.results?.[0]?.measure?.slug;
    const groupBy = p.aggregate?.groupBy ?? p.results?.[0]?.group?.type ?? 'unknown';
    if (!slug) continue;
    const key = `${slug}__${groupBy}`;
    const mtime = fsSync.statSync(full).mtimeMs;
    const prev = seenByKey.get(key);
    if (!prev || prev.mtime < mtime) {
      seenByKey.set(key, { mtime, payload, file: f });
    }
  }

  for (const [key, entry] of seenByKey) {
    const p = entry.payload as {
      results: Array<{
        measure: { id?: number; slug: string; name: string; unit?: string; description?: string };
        group: { id?: number | string; type?: string; name?: string; color?: string };
        points: Array<[string, number | null]>;
      }>;
      aggregate?: { groupBy?: string; interval?: string; aggregateFunction?: string };
    };
    const first = p.results[0];
    const groups: TimeseriesGroup[] = p.results.map((r) => ({
      id: r.group.id ?? null,
      type: r.group.type ?? null,
      name: r.group.name ?? null,
      color: r.group.color ?? null,
      points: r.points,
    }));
    const allDates = groups.flatMap((g) => g.points.map((pt) => pt[0])).sort();
    const totalPoints = groups.reduce((acc, g) => acc + g.points.length, 0);

    const slug = first.measure.slug;
    out[slug] = {
      measure: {
        id: first.measure.id ?? null,
        slug,
        name: first.measure.name,
        unit: first.measure.unit ?? null,
        description: first.measure.description ?? null,
      },
      aggregate: {
        groupBy: p.aggregate?.groupBy ?? null,
        interval: p.aggregate?.interval ?? null,
        aggregateFunction: p.aggregate?.aggregateFunction ?? null,
      },
      groups,
      summary: {
        from: allDates[0] ?? null,
        to: allDates.at(-1) ?? null,
        pointCount: totalPoints,
        groupCount: groups.length,
      },
      capturedFrom: entry.file,
    };

    // Mirror the decoded payload to disk for human inspection / debugging.
    await fs.writeFile(
      path.join(decodedDir, `${key}.json`),
      JSON.stringify(entry.payload, null, 2),
    );
  }

  return out;
}

function extractNextData(html: string): {
  props?: {
    pageProps?: {
      asset?: Record<string, unknown> & {
        id?: number;
        name?: string;
        ticker?: string;
        slug?: string;
        description?: string;
        _updated_at?: string;
      };
      aggregates?: unknown[];
    };
  };
  buildId?: string;
} {
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!m) throw new Error('__NEXT_DATA__ script not found in HTML');
  return JSON.parse(m[1]);
}

function pickEntity<T extends string>(
  obj: unknown,
  keys: readonly T[],
): Record<T, unknown> | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const out = {} as Record<T, unknown>;
  let any = false;
  for (const k of keys) {
    if (o[k] !== undefined) {
      out[k] = o[k];
      if (o[k] !== null) any = true;
    } else {
      out[k] = null;
    }
  }
  return any ? out : null;
}

function buildMarketData(asset: Record<string, unknown>) {
  const groups: Record<keyof typeof METRIC_GROUPS, Record<string, MetricSnapshot>> = {
    yield: {},
    supply: {},
    value: {},
    holders: {},
    activity: {},
    mintsBurns: {},
  };
  for (const [group, keys] of Object.entries(METRIC_GROUPS) as [
    keyof typeof METRIC_GROUPS,
    readonly string[],
  ][]) {
    for (const k of keys) {
      const v = asset[k];
      const snap = toSnapshot(v);
      if (snap) groups[group][k] = snap;
    }
  }
  return groups;
}

function toSnapshot(v: unknown): MetricSnapshot | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const numOrNull = (k: string) =>
    typeof o[k] === 'number' && Number.isFinite(o[k] as number)
      ? (o[k] as number)
      : null;
  const snap: MetricSnapshot = {
    val: numOrNull('val'),
    val_7d: numOrNull('val_7d'),
    val_30d: numOrNull('val_30d'),
    val_90d: numOrNull('val_90d'),
    chg_7d_amt: numOrNull('chg_7d_amt'),
    chg_7d_pct: numOrNull('chg_7d_pct'),
    chg_30d_amt: numOrNull('chg_30d_amt'),
    chg_30d_pct: numOrNull('chg_30d_pct'),
    chg_90d_amt: numOrNull('chg_90d_amt'),
    chg_90d_pct: numOrNull('chg_90d_pct'),
  };
  // Skip entries where every field is null (asset doesn't expose this metric).
  if (Object.values(snap).every((x) => x === null)) return null;
  return snap;
}

// CLI mode: only run if this file is the entrypoint (not imported).
// `tsx scripts/extract-asset.ts --slug=USYC` works; `import { runExtract }`
// from refresh-all.ts does NOT re-trigger this.
const isCliEntry =
  import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}` ||
  import.meta.url.endsWith(path.basename(process.argv[1] ?? ''));

if (isCliEntry) {
  const slug = (() => {
    for (const a of process.argv.slice(2)) {
      const m = a.match(/^--slug=(.+)$/);
      if (m) return m[1];
    }
    console.error('Usage: tsx scripts/extract-asset.ts --slug=<TICKER>');
    process.exit(2);
  })();
  runExtract(slug).catch((e) => {
    console.error('extract-asset failed:');
    console.error(e);
    process.exit(1);
  });
}
