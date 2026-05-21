/**
 * Round-1 discovery scraper for app.rwa.xyz/assets/USYC.
 *
 * Goals:
 *   - Reuse a persistent Chrome profile so login survives across runs.
 *   - Record every JSON XHR the page makes (this is where the chart series lives).
 *   - Snapshot the rendered DOM + a screenshot for visual reference.
 *   - Write a heuristic data/USYC.json with whatever we can extract from the DOM.
 *
 * Round 2 will replace the DOM heuristics with typed mappers driven by the XHRs
 * we discover here.
 */
import { chromium, type Response } from 'playwright';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROFILE_DIR = path.join(ROOT, '.chrome-profile');
const DATA_DIR = path.join(ROOT, 'data');
const DEBUG_DIR = path.join(ROOT, '_debug');
const XHR_DIR = path.join(DEBUG_DIR, 'xhr');

// Required: `--slug=<TICKER>` (rwa.xyz path segment, e.g. USYC, NVDAon).
// Optional: `--no-pause` to skip the manual login pause — useful for batch
// runs from `refresh-all.ts` where the persistent profile is already authed.
const { SLUG, NO_PAUSE } = (() => {
  let slug: string | null = null;
  let noPause = false;
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--slug=(.+)$/);
    if (m) slug = m[1];
    if (a === '--no-pause') noPause = true;
  }
  if (!slug) {
    console.error('Usage: tsx scripts/scrape-asset.ts --slug=<TICKER> [--no-pause]');
    process.exit(2);
  }
  return { SLUG: slug, NO_PAUSE: noPause };
})();
const TARGET_URL = `https://app.rwa.xyz/assets/${SLUG}`;

interface XhrRecord {
  url: string;
  method: string;
  status: number;
  contentType: string;
  file: string;
  bytes: number;
}

async function main() {
  await Promise.all([
    fs.mkdir(DATA_DIR, { recursive: true }),
    fs.mkdir(XHR_DIR, { recursive: true }),
    fs.mkdir(PROFILE_DIR, { recursive: true }),
  ]);

  console.log(`Launching Chromium with profile: ${PROFILE_DIR}`);
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = ctx.pages()[0] ?? (await ctx.newPage());

  const xhrLog: XhrRecord[] = [];
  let xhrIdx = 0;

  page.on('response', async (resp: Response) => {
    try {
      const url = resp.url();
      const ct = resp.headers()['content-type'] ?? '';
      // Only capture JSON, and only from rwa.xyz / likely API hosts.
      if (!/json/i.test(ct)) return;
      if (!/rwa\.xyz|amazonaws|cloudfront|api\.|graphql/i.test(url)) return;

      const body = await resp.text();
      const idx = xhrIdx++;
      const fname = `${String(idx).padStart(3, '0')}-${resp.status()}-${sanitizeUrl(url)}.json`;
      const fpath = path.join(XHR_DIR, fname);
      await fs.writeFile(fpath, body);

      xhrLog.push({
        url,
        method: resp.request().method(),
        status: resp.status(),
        contentType: ct,
        file: fname,
        bytes: body.length,
      });
    } catch {
      // resp.text() can throw on aborted/redirect responses — ignore.
    }
  });

  console.log(`Navigating to ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

  // Always pause — auto-detection is unreliable (login affordances vary,
  // some assets render partially while logged-out, etc.). Let the operator
  // confirm the page is ready before we snapshot + extract.
  // Skip the pause when `--no-pause` is passed (batch mode); rely on
  // networkidle + an extra settling delay instead.
  if (NO_PAUSE) {
    console.log('(--no-pause) skipping manual confirmation; waiting 4s for late XHRs…');
    await page.waitForTimeout(4000);
  } else {
    console.log('');
    console.log('========================================================');
    console.log(` PAUSED — review the Chrome window for asset ${SLUG}.`);
    console.log('');
    console.log('  - If a login wall / paywall is shown, sign in there now.');
    console.log('  - If the asset page is already rendered, that\'s fine too.');
    console.log('  - Dismiss any cookie / consent banners.');
    console.log('  - For yield-bearing assets, click "7D APY" in the Treasury');
    console.log('    Product Metrics section so the APY timeseries XHR fires.');
    console.log('');
    console.log(' When the page looks good, return here and press ENTER.');
    console.log(' (Type "r" + ENTER to reload the page first, then capture.)');
    console.log('========================================================');
    const rl = readline.createInterface({ input, output });
    const answer = (await rl.question('> ')).trim().toLowerCase();
    rl.close();

    if (answer === 'r' || answer === 'reload') {
      console.log('Reloading page so XHRs re-fire with your authed session…');
      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    }
  }

  console.log('Scrolling page to trigger lazy chart renders…');
  await page.evaluate(async () => {
    const step = 400;
    const height = document.documentElement.scrollHeight;
    for (let y = 0; y < height; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 250));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(3000);

  console.log('Snapshotting DOM + screenshot…');
  await fs.writeFile(path.join(DEBUG_DIR, `${SLUG}.html`), await page.content());
  await page.screenshot({ path: path.join(DEBUG_DIR, `${SLUG}.png`), fullPage: true });
  await fs.writeFile(
    path.join(DEBUG_DIR, `${SLUG}.xhr-index.json`),
    JSON.stringify(xhrLog, null, 2),
  );

  console.log('');
  console.log('Capture done.');
  console.log(`  html:        _debug/${SLUG}.html`);
  console.log(`  screenshot:  _debug/${SLUG}.png`);
  console.log(`  xhr index:   _debug/${SLUG}.xhr-index.json`);
  console.log(`  xhr bodies:  _debug/xhr/  (${xhrLog.length} JSON responses)`);
  console.log('');
  console.log('Next: run `npm run extract:usyc` to parse __NEXT_DATA__ from the HTML');
  console.log('and write the normalized data/USYC.json record.');

  await ctx.close();
}

function sanitizeUrl(u: string): string {
  return u
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9.-]/gi, '_')
    .slice(0, 100);
}

main().catch((err) => {
  console.error('\nscrape-usyc failed:');
  console.error(err);
  process.exit(1);
});
