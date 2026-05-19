/**
 * Wave 5 Q1 — RWA oracle ingest operator script.
 *
 * Reads every `development/ORACLE_DATA_MINE/data/*.json` payload (the
 * per-asset output of `extract-asset.ts`) and POSTs the bundle to
 * `POST /api/v1/admin/oracle/ingest` on the configured backend.
 *
 * USAGE (operator dev machine):
 *
 *   # Default: localhost backend
 *   export ORACLE_INGEST_SERVICE_SECRET=<same value as backend env>
 *   pnpm --filter @muhaven/backend exec tsx scripts/ingest-oracle.ts
 *
 *   # Or against a remote backend
 *   ORACLE_INGEST_URL=https://api.muhaven.app \
 *     ORACLE_INGEST_SERVICE_SECRET=<…> \
 *     pnpm --filter @muhaven/backend exec tsx scripts/ingest-oracle.ts
 *
 *   # Filter to specific tickers
 *   tsx scripts/ingest-oracle.ts --only=USYC,BUIDL
 *
 *   # Dry-run: validate the JSON files but don't POST
 *   tsx scripts/ingest-oracle.ts --dry-run
 *
 * Why a script, not a route handler that scans the filesystem itself:
 * the backend container does NOT mount `development/ORACLE_DATA_MINE/`,
 * and that's intentional — the rwa.xyz scrape lives on the operator
 * machine with the persistent Chromium profile + cookies. The script
 * runs from the repo root and pushes the harvested JSON into the
 * backend via the same HTTPS path the future 8-hour cron will use.
 *
 * NOT committed: the `data/*.json` payloads themselves — the entire
 * `development/` tree is gitignored (`.gitignore:59`). The script is
 * tracked because it lives under `backend/scripts/` which IS tracked.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve `development/ORACLE_DATA_MINE/data/` relative to the repo
// root. `__dirname` is `<repo>/backend/scripts`; the data dir is two
// levels up + into `development/…`.
const REPO_ROOT = resolve(__dirname, '..', '..');
const DATA_DIR = join(REPO_ROOT, 'development', 'ORACLE_DATA_MINE', 'data');

interface CliArgs {
  url: string;
  secret: string | undefined;
  dryRun: boolean;
  only: Set<string> | null;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let only: Set<string> | null = null;
  let dryRun = false;

  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--only=')) {
      only = new Set(
        arg
          .slice('--only='.length)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else {
      console.error(`Unknown argument: ${arg}`);
      console.error('Usage: tsx scripts/ingest-oracle.ts [--dry-run] [--only=TICKER1,TICKER2]');
      process.exit(2);
    }
  }

  return {
    url: process.env.ORACLE_INGEST_URL ?? 'http://localhost:3000',
    secret: process.env.ORACLE_INGEST_SERVICE_SECRET,
    dryRun,
    only,
  };
}

function loadAssets(only: Set<string> | null): Array<{ filename: string; payload: unknown }> {
  let entries: string[];
  try {
    entries = readdirSync(DATA_DIR);
  } catch (err) {
    console.error(`Could not read data dir ${DATA_DIR}:`, err);
    process.exit(1);
  }

  const jsonFiles = entries
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (jsonFiles.length === 0) {
    console.error(`No .json files in ${DATA_DIR}. Run the scraper first.`);
    process.exit(1);
  }

  const out: Array<{ filename: string; payload: unknown }> = [];
  for (const filename of jsonFiles) {
    const full = join(DATA_DIR, filename);
    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(full, 'utf8'));
    } catch (err) {
      console.error(`  ✗ ${filename} — failed to parse: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    const ticker = extractTicker(payload);
    if (!ticker) {
      console.error(`  ✗ ${filename} — no ticker field; skipped`);
      continue;
    }
    if (only && !only.has(ticker)) continue;
    out.push({ filename, payload });
  }
  return out;
}

function extractTicker(payload: unknown): string | undefined {
  if (
    payload &&
    typeof payload === 'object' &&
    'ticker' in payload &&
    typeof (payload as { ticker: unknown }).ticker === 'string'
  ) {
    return (payload as { ticker: string }).ticker;
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (!args.dryRun && !args.secret) {
    console.error(
      'ORACLE_INGEST_SERVICE_SECRET is not set. Export it or pass --dry-run.',
    );
    process.exit(1);
  }

  console.log(`[ingest-oracle] data dir : ${DATA_DIR}`);
  console.log(`[ingest-oracle] backend  : ${args.url}`);
  if (args.only) console.log(`[ingest-oracle] only     : ${[...args.only].join(', ')}`);
  if (args.dryRun) console.log('[ingest-oracle] dry-run mode — no POST');

  const assets = loadAssets(args.only);
  console.log(`[ingest-oracle] loaded ${assets.length} payload(s):`);
  for (const a of assets) {
    const ticker = extractTicker(a.payload);
    console.log(`  • ${ticker?.padEnd(10) ?? '???       '} (${a.filename})`);
  }

  if (assets.length === 0) {
    console.error('Nothing to ingest.');
    process.exit(1);
  }

  if (args.dryRun) {
    console.log('[ingest-oracle] dry-run complete — exiting without POST');
    return;
  }

  const endpoint = `${args.url.replace(/\/$/, '')}/api/v1/admin/oracle/ingest`;

  // POST one asset per request. The endpoint accepts up to 64 in a
  // single batch, but per-asset chunking keeps each request well under
  // typical 1MB body limits (USDY.json alone is ~900KB) and lets the
  // operator see per-token progress on the dev machine. A single bad
  // payload only takes its own request down. Re-runs are idempotent on
  // metadata + timeseries; oracle_snapshots gains an extra row, which
  // is acceptable.
  const allResults: unknown[] = [];
  let failures = 0;
  for (const { filename, payload } of assets) {
    const ticker = extractTicker(payload) ?? '???';
    const body = JSON.stringify({ assets: [payload] });

    process.stdout.write(`  POST ${ticker.padEnd(10)} (${body.length.toString().padStart(7)} bytes) … `);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.secret}`,
          'Content-Type': 'application/json',
        },
        body,
      });
      const text = await res.text();
      if (!res.ok) {
        console.log(`HTTP ${res.status}`);
        console.log(`    ${text.slice(0, 500)}`);
        failures += 1;
        allResults.push({ filename, ticker, http: res.status, body: text.slice(0, 500) });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        console.log('non-JSON response');
        failures += 1;
        allResults.push({ filename, ticker, http: 200, raw: text.slice(0, 500) });
        continue;
      }
      // Backend returns `{ results: [...], summary: {...} }`. We only
      // sent one asset so .results[0] is canonical.
      const summary = (parsed as { results?: Array<{ status?: string; timeseriesPointsUpserted?: number }> }).results?.[0];
      const status = summary?.status ?? 'unknown';
      const pts = summary?.timeseriesPointsUpserted ?? 0;
      console.log(`${status} (${pts} timeseries pts)`);
      if (status !== 'ok') failures += 1;
      allResults.push({ filename, ticker, ...summary });
    } catch (err) {
      console.log(`fetch threw: ${err instanceof Error ? err.message : err}`);
      failures += 1;
      allResults.push({ filename, ticker, fetchError: String(err) });
    }
  }

  console.log('');
  console.log(`[ingest-oracle] done — ${assets.length - failures}/${assets.length} OK, ${failures} failures`);
  if (failures > 0) {
    console.log('[ingest-oracle] details:');
    console.log(JSON.stringify(allResults.filter((r) => (r as { status?: string }).status !== 'ok'), null, 2));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[ingest-oracle] uncaught:', err);
  process.exit(1);
});
