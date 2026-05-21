/**
 * Batch refresh: scrape + fetch:timeseries + extract for every asset in
 * `assets.json`. Single Chrome session, headed (per Q2 design — controlled
 * browser is the reliability story).
 *
 * Designed to be the entrypoint for an 8-hour Windows Task Scheduler cron:
 *   tsx scripts/refresh-all.ts
 *
 * Phase 1 (with browser open):
 *   - Sanity probe: hit a known-good API endpoint to confirm session is authed.
 *     Bail loudly if not — operator must re-auth via `scrape-asset.ts` once.
 *   - For each asset in the manifest:
 *     - navigate to /assets/<slug>, wait, scroll (XHR listener captures everything)
 *     - if yield-bearing, click "7D APY" so the APY timeseries XHR fires
 *     - explicitly fetch category-appropriate timeseries slugs via API
 *       (defense in depth — even if the click missed, we have the series)
 *     - snapshot HTML + screenshot to _debug/<slug>.{html,png}
 *
 * Phase 2 (browser closed):
 *   - Spawn `tsx scripts/extract-asset.ts --slug=<X>` per asset.
 *     Cheap subprocess; keeps the single-asset extract behavior identical.
 *
 * Output:
 *   - data/<SLUG>.json for each asset
 *   - _debug/<SLUG>.{html,png,xhr-index.json}
 *   - _debug/xhr/* shared bin for all captures
 *   - _debug/refresh-history.log appended with per-run summary
 */
import { chromium, type APIRequestContext, type BrowserContext, type Page, type Response } from 'playwright';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeRwaXyzTrpc, extractTrpcData, isEncodedTrpcData } from './lib/rwaxyz-decode.ts';
import { runExtract } from './extract-asset.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROFILE_DIR = path.join(ROOT, '.chrome-profile');
const DEBUG_DIR = path.join(ROOT, '_debug');
const XHR_DIR = path.join(DEBUG_DIR, 'xhr');
const HISTORY_LOG = path.join(DEBUG_DIR, 'refresh-history.log');
const MANIFEST_PATH = path.join(ROOT, 'assets.json');

interface Manifest {
  categories: Record<
    string,
    { displayName: string; isYieldBearing: boolean; timeseriesSlugs: string[] }
  >;
  assets: Array<{ slug: string; category: string }>;
}

interface AssetResult {
  slug: string;
  category: string;
  scrapeOk: boolean;
  timeseriesFetched: string[];
  extractOk: boolean;
  error?: string;
}

async function main() {
  const manifest: Manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
  console.log(`Refresh-all: ${manifest.assets.length} assets across ${Object.keys(manifest.categories).length} categories`);
  console.log('');

  await fs.mkdir(XHR_DIR, { recursive: true });

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // Single shared XHR listener — every navigation in this context fires here.
  // Files land in _debug/xhr/ with a unique counter prefix; the extractor
  // filters by asset_id inside the decoded payload (not by filename).
  let xhrIdx = 0;
  let xhrCount = 0;
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('response', async (resp: Response) => {
    try {
      const url = resp.url();
      const ct = resp.headers()['content-type'] ?? '';
      if (!/json/i.test(ct)) return;
      if (!/rwa\.xyz|amazonaws|cloudfront|api\.|graphql/i.test(url)) return;
      const body = await resp.text();
      const idx = xhrIdx++;
      const fname = `${String(idx).padStart(4, '0')}-${resp.status()}-${sanitizeUrl(url)}.json`;
      await fs.writeFile(path.join(XHR_DIR, fname), body);
      xhrCount++;
    } catch {
      // ignore aborted / redirected responses
    }
  });

  const results: AssetResult[] = [];

  console.log('Sanity probe (USYC measure 71 — known good)…');
  const sanityOk = await sanityProbe(ctx.request);
  if (!sanityOk) {
    console.error('✗ Session is stale or invalid.');
    console.error('  Re-auth: `tsx scripts/scrape-asset.ts --slug=USYC` (manual login), then re-run.');
    await ctx.close();
    process.exit(2);
  }
  console.log('  ✓ session authed');
  console.log('');

  // Phase 1: scrape every asset
  for (const asset of manifest.assets) {
    const cat = manifest.categories[asset.category];
    if (!cat) {
      results.push({ slug: asset.slug, category: asset.category, scrapeOk: false, timeseriesFetched: [], extractOk: false, error: `unknown category ${asset.category}` });
      continue;
    }
    console.log(`[${asset.slug}] (${asset.category}) →`);
    const r = await scrapeOne(page, ctx.request, asset.slug, cat);
    results.push({ slug: asset.slug, category: asset.category, extractOk: false, ...r });
    console.log('');
  }

  console.log(`Phase 1 done. ${xhrCount} XHRs captured across ${manifest.assets.length} assets.`);
  await ctx.close();

  // Phase 2: extract each asset (in-process, no subprocess overhead).
  console.log('');
  console.log('Phase 2: per-asset extract…');
  for (const r of results) {
    if (!r.scrapeOk) {
      console.log(`  [${r.slug}] skipped (scrape failed)`);
      continue;
    }
    try {
      await runExtract(r.slug);
      r.extractOk = true;
      console.log(`  [${r.slug}] extract ✓`);
    } catch (e) {
      r.extractOk = false;
      r.error = (r.error ? r.error + '; ' : '') + 'extract: ' + (e as Error).message;
      console.log(`  [${r.slug}] extract ✗ ${(e as Error).message}`);
    }
  }

  // Summary
  console.log('');
  console.log('============= summary =============');
  console.log(' slug       cat                scrape  ts-fetched           extract');
  console.log(' ---------  -----------------  ------  -------------------  -------');
  for (const r of results) {
    console.log(
      ` ${r.slug.padEnd(10)} ${r.category.padEnd(18)} ${r.scrapeOk ? '✓' : '✗'.padEnd(6)}  ${r.timeseriesFetched.join(',').padEnd(19)}  ${r.extractOk ? '✓' : '✗'}`,
    );
  }
  await appendHistory(results);
}

function sanitizeUrl(u: string): string {
  return u.replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]/gi, '_').slice(0, 100);
}

async function sanityProbe(request: APIRequestContext): Promise<boolean> {
  const url = buildTimeseriesUrl({ assetId: 51, slug: 'apy_7_day', perPage: 1 });
  try {
    const resp = await request.get(url, { headers: defaultHeaders('USYC'), timeout: 15_000 });
    if (!resp.ok()) return false;
    const data = extractTrpcData(JSON.parse(await resp.text()));
    if (!isEncodedTrpcData(data)) return false;
    const decoded = decodeRwaXyzTrpc(data) as { results?: Array<{ measure?: { slug?: string } }> };
    return decoded.results?.[0]?.measure?.slug === 'apy_7_day';
  } catch {
    return false;
  }
}

function defaultHeaders(slug: string) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    referer: `https://app.rwa.xyz/assets/${slug}`,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };
}

function buildTimeseriesUrl(opts: { assetId: number; slug: string; perPage: number }) {
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

async function scrapeOne(
  page: Page,
  request: APIRequestContext,
  slug: string,
  cat: Manifest['categories'][string],
): Promise<{ scrapeOk: boolean; timeseriesFetched: string[]; error?: string }> {
  const url = `https://app.rwa.xyz/assets/${slug}`;
  try {
    process.stdout.write(`  goto… `);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

    process.stdout.write(`scroll… `);
    await page.evaluate(async () => {
      const step = 400;
      const h = document.documentElement.scrollHeight;
      for (let y = 0; y < h; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 150));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1500);

    // For yield-bearing assets, click "7D APY" so the rwa.xyz UI fires the
    // assetTimeseriesV4 XHR for apy_7_day with the canonical params. The
    // explicit API fetch below is the safety net.
    if (cat.isYieldBearing) {
      const clicked = await tryClickApyTab(page);
      process.stdout.write(`apy-tab=${clicked ? 'click' : 'skip'} `);
      if (clicked) await page.waitForTimeout(1500);
    }

    // Snapshot
    process.stdout.write(`snap… `);
    await fs.writeFile(path.join(DEBUG_DIR, `${slug}.html`), await page.content());
    await page.screenshot({ path: path.join(DEBUG_DIR, `${slug}.png`), fullPage: true });

    // Read __NEXT_DATA__ → asset.id (needed for API fetches in this loop)
    const html = await fs.readFile(path.join(DEBUG_DIR, `${slug}.html`), 'utf8');
    const nextDataMatch = html.match(
      /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
    );
    if (!nextDataMatch) throw new Error('no __NEXT_DATA__ in saved HTML');
    const nd = JSON.parse(nextDataMatch[1]) as { props?: { pageProps?: { asset?: { id?: number } } } };
    const assetId = nd.props?.pageProps?.asset?.id;
    if (typeof assetId !== 'number') throw new Error(`no asset.id in __NEXT_DATA__ for slug=${slug}`);

    // Explicit API fetches for the category's timeseries slug list
    process.stdout.write(`fetch[${cat.timeseriesSlugs.length}]: `);
    const fetched: string[] = [];
    for (const measureSlug of cat.timeseriesSlugs) {
      const ok = await fetchAndSaveSeries(request, slug, assetId, measureSlug);
      process.stdout.write(`${measureSlug}=${ok ? 'ok' : '-'} `);
      if (ok) fetched.push(measureSlug);
      await sleep(150);
    }

    process.stdout.write('\n');
    return { scrapeOk: true, timeseriesFetched: fetched };
  } catch (e) {
    process.stdout.write('\n');
    return { scrapeOk: false, timeseriesFetched: [], error: (e as Error).message };
  }
}

async function tryClickApyTab(page: Page): Promise<boolean> {
  const candidates = [
    'button:has-text("7D APY")',
    'button:has-text("APY (7-Day)")',
    'a:has-text("7D APY")',
    '[role="tab"]:has-text("7D APY")',
    '[role="tab"]:has-text("APY")',
  ];
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      await loc.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
      await loc.click({ timeout: 1500 });
      return true;
    } catch {
      // try next selector
    }
  }
  return false;
}

async function fetchAndSaveSeries(
  request: APIRequestContext,
  slug: string,
  assetId: number,
  measureSlug: string,
): Promise<boolean> {
  try {
    const url = buildTimeseriesUrl({ assetId, slug: measureSlug, perPage: 2000 });
    const resp = await request.get(url, { headers: defaultHeaders(slug), timeout: 30_000 });
    if (!resp.ok()) return false;
    const text = await resp.text();
    const body = JSON.parse(text);
    const data = extractTrpcData(body);
    if (!isEncodedTrpcData(data)) return false;
    // Save under the assetTimeseriesV4 filename pattern so extract-asset's
    // scanner picks it up automatically.
    const fname = `fetched-asset-${assetId}-${measureSlug}--assetTimeseriesV4.queryTimeseries.json`;
    await fs.writeFile(path.join(XHR_DIR, fname), text);
    return true;
  } catch {
    return false;
  }
}

async function appendHistory(results: AssetResult[]): Promise<void> {
  const ts = new Date().toISOString();
  const ok = results.filter((r) => r.scrapeOk && r.extractOk).length;
  const total = results.length;
  const failed = results.filter((r) => !r.scrapeOk || !r.extractOk).map((r) => r.slug).join(',');
  const line = `[${ts}] ${ok}/${total} ok${failed ? ` failed=${failed}` : ''}\n`;
  try {
    await fs.appendFile(HISTORY_LOG, line);
  } catch {
    // ignore
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error('refresh-all failed:');
  console.error(e);
  process.exit(1);
});
