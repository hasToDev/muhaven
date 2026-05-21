/**
 * Fetch asset-level timeseries from rwa.xyz by `measure_slug`.
 *
 * Uses `assetTimeseriesV4.queryTimeseries` — the endpoint the rwa.xyz UI hits
 * when you click an APY / NAV / yield chart. It accepts slugs directly, so we
 * skip the numeric-ID probing dance entirely.
 *
 * Usage:
 *   npm run fetch:timeseries                            # default: USYC, full slug list
 *   npm run fetch:timeseries -- --asset-id=51
 *   npm run fetch:timeseries -- --slugs=apy_7_day,daily_yield_rate
 *   npm run fetch:timeseries -- --asset-id=51 --per-page=2000
 *
 * Each fetched series lands in `_debug/xhr/` with `assetTimeseriesV4.queryTimeseries`
 * in the filename so `extract:usyc`'s scanner picks it up on the next run.
 *
 * Sibling endpoint `tokenTimeseries.queryTimeseries` is token-level (per-network)
 * and uses numeric `measure_id`. It's what the page hits for the per-chain TVL
 * chart that loads by default; we capture that one organically during scrape.
 */
import { chromium, type APIRequestContext } from 'playwright';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeRwaXyzTrpc, extractTrpcData, isEncodedTrpcData } from './lib/rwaxyz-decode.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROFILE_DIR = path.join(ROOT, '.chrome-profile');
const XHR_DIR = path.join(ROOT, '_debug', 'xhr');

const DEFAULT_ASSET_ID = 51; // USYC
const DEFAULT_SLUGS = [
  'apy_7_day',
  'apy_30_day',
  'daily_yield_rate',
  'yield_to_maturity_percent',
  'net_asset_value_dollar',
  'price_dollar',
  'daily_yield_distributed_dollar',
  'hypothetical_10_000_performance',
];

function parseArgs() {
  const args = new Map<string, string>();
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) args.set(m[1], m[2]);
  }
  return {
    assetId: Number(args.get('asset-id') ?? DEFAULT_ASSET_ID),
    slugs: (args.get('slugs') ?? DEFAULT_SLUGS.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    perPage: Number(args.get('per-page') ?? 2000),
  };
}

function buildUrl(opts: { assetId: number; slug: string; perPage: number }) {
  const input = JSON.stringify({
    query: {
      aggregate: { groupBy: 'asset', aggregateFunction: 'sum', interval: 'day' },
      filter: {
        operator: 'and',
        filters: [
          { field: 'asset_id', operator: 'equals', value: opts.assetId },
          { field: 'measure_slug', operator: 'equals', value: opts.slug },
        ],
      },
      sort: { direction: 'asc', field: 'date' },
      pagination: { page: 1, perPage: opts.perPage },
    },
  });
  return `https://app.rwa.xyz/api/trpc/assetTimeseriesV4.queryTimeseries?input=${encodeURIComponent(input)}`;
}

type FetchResult =
  | {
      kind: 'ok';
      measureSlug: string;
      measureName: string;
      unit: string | null;
      pointCount: number;
      rawBody: string;
    }
  | { kind: 'empty'; status: number }
  | { kind: 'error'; status: number; message: string };

async function fetchOne(
  request: APIRequestContext,
  opts: { assetId: number; slug: string; perPage: number },
): Promise<FetchResult> {
  const resp = await request.get(buildUrl(opts), {
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      referer: `https://app.rwa.xyz/assets/USYC`,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    },
    timeout: 30_000,
  });
  if (!resp.ok()) {
    return {
      kind: 'error',
      status: resp.status(),
      message: (await resp.text().catch(() => '')).slice(0, 200),
    };
  }
  const text = await resp.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return { kind: 'error', status: resp.status(), message: `not JSON: ${(e as Error).message}` };
  }
  let data: unknown;
  try {
    data = extractTrpcData(body);
  } catch (e) {
    return { kind: 'error', status: resp.status(), message: (e as Error).message };
  }
  if (!isEncodedTrpcData(data)) {
    return { kind: 'empty', status: resp.status() };
  }
  let payload: {
    results?: Array<{
      measure?: { slug?: string; name?: string; unit?: string };
      points?: unknown[];
    }>;
  };
  try {
    payload = decodeRwaXyzTrpc(data) as typeof payload;
  } catch (e) {
    return { kind: 'error', status: resp.status(), message: `decode failed: ${(e as Error).message}` };
  }
  const r = payload.results?.[0];
  if (!r?.measure?.slug) {
    return { kind: 'empty', status: resp.status() };
  }
  return {
    kind: 'ok',
    measureSlug: r.measure.slug,
    measureName: r.measure.name ?? '',
    unit: r.measure.unit ?? null,
    pointCount: r.points?.length ?? 0,
    rawBody: text,
  };
}

async function main() {
  const { assetId, slugs, perPage } = parseArgs();
  console.log(
    `Fetching ${slugs.length} measure_slug(s) for asset_id=${assetId} (perPage=${perPage}):`,
  );
  for (const s of slugs) console.log(`  - ${s}`);
  console.log('');

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1440, height: 900 },
  });
  // Warm cookies — assetTimeseriesV4 requires an authed session.
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('https://app.rwa.xyz/assets/USYC', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

  await fs.mkdir(XHR_DIR, { recursive: true });

  let ok = 0;
  let empty = 0;
  let error = 0;
  for (const slug of slugs) {
    const r = await fetchOne(ctx.request, { assetId, slug, perPage });
    if (r.kind === 'ok') {
      ok++;
      // Filename includes the procedure name so extract-usyc's scanner picks it up.
      const fname = `fetched-asset-${assetId}-${slug}--assetTimeseriesV4.queryTimeseries.json`;
      await fs.writeFile(path.join(XHR_DIR, fname), r.rawBody);
      console.log(
        `  ✓ ${slug.padEnd(36)} ${String(r.pointCount).padStart(5)} pts  unit=${(r.unit ?? '-').padEnd(8)} saved`,
      );
    } else if (r.kind === 'empty') {
      empty++;
      console.log(`  - ${slug.padEnd(36)} no series for asset_id=${assetId}`);
    } else {
      error++;
      console.log(
        `  ✗ ${slug.padEnd(36)} HTTP ${r.status}: ${r.message.slice(0, 100)}`,
      );
    }
    await sleep(150);
  }

  console.log('');
  console.log(`Result: ${ok} ok, ${empty} empty, ${error} error`);
  if (error && ok === 0 && empty === 0) {
    console.error('Looks like an auth issue. Re-run `npm run scrape:usyc` to refresh the profile session.');
    process.exitCode = 2;
  } else if (ok > 0) {
    console.log('Next: `npm run extract:usyc` will fold these into data/USYC.json.');
  }

  await ctx.close();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error('fetch-timeseries failed:');
  console.error(e);
  process.exit(1);
});
