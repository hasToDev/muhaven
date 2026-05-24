/**
 * Marketplace token-icon self-host downloader (Wave 5).
 *
 * WHY: the SPA is served with `Cross-Origin-Embedder-Policy: require-corp`
 * (load-bearing for the FHE WASM's `SharedArrayBuffer`). That header blocks
 * the third-party rwa.xyz S3 icon URLs the marketplace cards used to load,
 * so the icons render broken. The fix (operator-chosen "bake into
 * frontend/public") is to download each token's icon to OUR origin so COEP
 * is satisfied — same-origin subresources are exempt outright.
 *
 * WHAT this does: resolve each oracle token's icon URL, download the bytes
 * on the operator's machine (NOT the backend — keeps backend egress / SSRF
 * surface out of it), validate them (size cap + magic-byte sniff, raster
 * only, SVG rejected), write `frontend/public/token-icons/<TICKER>.<ext>`,
 * and regenerate the typed manifest `frontend/src/data/tokenIcons.generated.ts`
 * the frontend resolver reads. Idempotent: a re-run with unchanged icons
 * writes nothing (sha256 compare; manifest content-compared), so it doesn't
 * churn the git tree.
 *
 * The icon set is near-static, so this is a STANDALONE on-demand tool — run
 * it for the initial backfill and whenever icons change, then rebuild +
 * push the frontend. It is deliberately NOT wired into the 8h scrape cron.
 *
 * USAGE (from scripts/oracle-mine):
 *   npm run fetch:icons                         # source live prod oracle API
 *   tsx scripts/fetch-icons.ts --dry-run        # validate, write nothing
 *   tsx scripts/fetch-icons.ts --only=CETES,USYC
 *   tsx scripts/fetch-icons.ts --source=data-dir   # read local scrape JSON
 *   ORACLE_TOKENS_URL=https://api-stage.muhaven.app tsx scripts/fetch-icons.ts
 *
 * SOURCE: `api` (default) reads the list the marketplace actually renders
 * from (the live oracle read API) — the source of truth, so baking what it
 * serves keeps icons in lockstep with the catalog. `data-dir` reads the
 * local scrape JSON instead (offline / pre-ingest). Either way the icon
 * BYTES are always fetched on THIS operator machine, never the backend —
 * that's what "scraper-side download" means for SSRF/egress.
 *
 * EXIT CODES: 2 = usage/config error (bad flag, unreachable source);
 * 1 = one or more per-icon download/validation failures; 0 = success.
 * A token with no icon_url is a skip, not an error.
 *
 * FLAGS:
 *   --source=api|data-dir   icon-URL source (default: api)
 *   --api-url=<origin>      backend origin for --source=api
 *                           (default: $ORACLE_TOKENS_URL or https://api.muhaven.app)
 *   --data-dir=<dir>        override the scrape data dir (--source=data-dir)
 *   --only=T1,T2            restrict to these tickers
 *   --out=<dir>             icon output dir (default: frontend/public/token-icons)
 *   --manifest=<file>       manifest path (default: frontend/src/data/tokenIcons.generated.ts)
 *   --max-bytes=<n>         per-icon size cap (default: 512 KB)
 *   --allow-http            permit http: source URLs (default: https only)
 *   --dry-run               do everything except write files
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkIconUrl,
  isSafeTicker,
  validateIconBytes,
  readBodyCapped,
  DEFAULT_MAX_ICON_BYTES,
  type AllowedImageType,
} from './lib/icon-validate.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const ORACLE_MINE_ROOT = path.resolve(HERE, '..');

const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'frontend', 'public', 'token-icons');
const DEFAULT_MANIFEST_FILE = path.join(
  REPO_ROOT,
  'frontend',
  'src',
  'data',
  'tokenIcons.generated.ts',
);
const DEFAULT_DATA_DIR = path.join(ORACLE_MINE_ROOT, 'data');

// All file extensions a ticker icon might have used on a prior run — so a
// re-run that changes a token's format (e.g. .jpg → .png) removes the stale
// sibling instead of leaving two icons for one ticker.
const ALL_ICON_EXTS = ['png', 'jpg', 'webp', 'gif'] as const;

const FETCH_TIMEOUT_MS = 20_000;

/**
 * Per-ticker icon-URL overrides. The oracle DB faithfully stores whatever
 * rwa.xyz published; for a couple of tokens that's a raw multi-MB S3 upload
 * rather than the optimized 128px CDN icon. Pin the small CDN variant so we
 * bake a sane-sized icon instead of tripping the size cap.
 */
const ICON_URL_OVERRIDES: Readonly<Record<string, string>> = {
  // DB value is a ~5.7 MB raw S3 JPEG (.../uploads/images/-STABLEBOND-02.jpg);
  // the rwa.xyz CDN serves a ~21 KB 128px PNG under this slug.
  CETES: 'https://img.rwa.xyz/content/asset-icons/128/color/etherfuse_cetes.png',
};

interface CliArgs {
  source: 'api' | 'data-dir';
  apiUrl: string;
  dataDir: string;
  only: Set<string> | null;
  outDir: string;
  manifestFile: string;
  maxBytes: number;
  allowHttp: boolean;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const out: CliArgs = {
    source: 'api',
    apiUrl: process.env.ORACLE_TOKENS_URL ?? 'https://api.muhaven.app',
    dataDir: DEFAULT_DATA_DIR,
    only: null,
    outDir: DEFAULT_OUT_DIR,
    manifestFile: DEFAULT_MANIFEST_FILE,
    maxBytes: DEFAULT_MAX_ICON_BYTES,
    allowHttp: false,
    dryRun: false,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--allow-http') out.allowHttp = true;
    else if (arg.startsWith('--source=')) {
      const v = arg.slice('--source='.length);
      if (v !== 'api' && v !== 'data-dir') fail(`--source must be "api" or "data-dir" (got "${v}")`);
      out.source = v;
    } else if (arg.startsWith('--api-url=')) out.apiUrl = arg.slice('--api-url='.length);
    else if (arg.startsWith('--data-dir=')) out.dataDir = path.resolve(arg.slice('--data-dir='.length));
    else if (arg.startsWith('--out=')) out.outDir = path.resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--manifest=')) out.manifestFile = path.resolve(arg.slice('--manifest='.length));
    else if (arg.startsWith('--max-bytes=')) {
      const n = Number(arg.slice('--max-bytes='.length));
      if (!Number.isInteger(n) || n <= 0) fail(`--max-bytes must be a positive integer (got "${arg}")`);
      out.maxBytes = n;
    } else if (arg.startsWith('--only=')) {
      out.only = new Set(
        arg
          .slice('--only='.length)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function fail(msg: string): never {
  console.error(`[fetch-icons] ${msg}`);
  process.exit(2);
}

interface TokenIconSource {
  ticker: string;
  url: string | null;
}

/** Source the (ticker, iconUrl) pairs from the live oracle read API. */
async function sourceFromApi(apiUrl: string): Promise<TokenIconSource[]> {
  const endpoint = `${apiUrl.replace(/\/$/, '')}/api/v1/oracle/tokens`;
  console.log(`[fetch-icons] source : ${endpoint}`);
  const res = await fetch(endpoint, { headers: { Accept: 'application/json' } });
  if (!res.ok) fail(`oracle list returned HTTP ${res.status}`);
  const body = (await res.json()) as { tokens?: Array<{ ticker?: unknown; icon_url?: unknown }> };
  if (!Array.isArray(body.tokens)) fail('oracle list response had no "tokens" array');
  return body.tokens
    .map((t) => ({
      ticker: typeof t.ticker === 'string' ? t.ticker : '',
      url: typeof t.icon_url === 'string' ? t.icon_url : null,
    }))
    .filter((t) => t.ticker.length > 0);
}

/** Source the (ticker, iconUrl) pairs from the local scrape data dir. */
function sourceFromDataDir(dataDir: string): TokenIconSource[] {
  console.log(`[fetch-icons] source : ${dataDir}`);
  let entries: string[];
  try {
    entries = fsSync.readdirSync(dataDir);
  } catch (err) {
    fail(`could not read data dir ${dataDir}: ${err instanceof Error ? err.message : err}`);
  }
  const out: TokenIconSource[] = [];
  for (const filename of entries.filter((f) => f.endsWith('.json')).sort()) {
    try {
      // `ticker` + `iconUrl` are the field names `extract-asset.ts` writes
      // into each data/<slug>.json (see extract-asset.ts: `iconUrl:
      // asset.icon_url`). Tokens with a null iconUrl fall through to the
      // "no icon_url — skipped" branch in the main loop.
      const payload = JSON.parse(fsSync.readFileSync(path.join(dataDir, filename), 'utf8')) as {
        ticker?: unknown;
        iconUrl?: unknown;
      };
      if (typeof payload.ticker !== 'string' || payload.ticker.length === 0) continue;
      out.push({
        ticker: payload.ticker,
        url: typeof payload.iconUrl === 'string' ? payload.iconUrl : null,
      });
    } catch (err) {
      console.error(`  ✗ ${filename} — parse failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return out;
}

interface DownloadOk {
  ok: true;
  ticker: string;
  type: AllowedImageType;
  ext: string;
  bytes: Uint8Array;
  sha256: string;
}
type DownloadResult = DownloadOk | { ok: false; ticker: string; reason: string };

async function downloadIcon(
  ticker: string,
  rawUrl: string,
  args: CliArgs,
): Promise<DownloadResult> {
  const urlCheck = checkIconUrl(rawUrl, { allowHttp: args.allowHttp });
  if (!urlCheck.ok) return { ok: false, ticker, reason: `url rejected: ${urlCheck.reason}` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(urlCheck.url, {
      signal: controller.signal,
      headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif,image/*' },
      redirect: 'follow',
    });

    // Re-validate the FINAL url after redirects — `checkIconUrl` only saw
    // the initial url, so a public CDN link that 30x-redirects to an
    // internal host (e.g. the metadata endpoint) would otherwise serve the
    // bytes we bake. Reject before reading/using the body. (`fetch` doesn't
    // expose intermediate hops, so this guards the final destination.)
    const finalCheck = checkIconUrl(res.url, { allowHttp: args.allowHttp });
    if (!finalCheck.ok) {
      return { ok: false, ticker, reason: `redirected to disallowed url: ${finalCheck.reason}` };
    }
    if (!res.ok) return { ok: false, ticker, reason: `HTTP ${res.status}` };

    // Fast reject on a declared Content-Length over the cap (avoids
    // streaming bytes we'll throw away). A missing header → "unknown",
    // which falls through to the streamed cap (the authoritative backstop
    // when the header is absent or lies).
    const clHeader = res.headers.get('content-length');
    const declared = clHeader === null ? NaN : Number(clHeader);
    if (Number.isFinite(declared) && declared > args.maxBytes) {
      return { ok: false, ticker, reason: `content-length ${declared} > cap ${args.maxBytes}` };
    }

    const read = await readBodyCapped(res, args.maxBytes);
    if ('tooLarge' in read) {
      return { ok: false, ticker, reason: `body exceeded cap ${args.maxBytes}` };
    }
    const verdict = validateIconBytes(read.bytes, { maxBytes: args.maxBytes });
    if (!verdict.ok) return { ok: false, ticker, reason: verdict.reason };

    const sha256 = createHash('sha256').update(read.bytes).digest('hex');
    return { ok: true, ticker, type: verdict.type, ext: verdict.ext, bytes: read.bytes, sha256 };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? `timed out after ${FETCH_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, ticker, reason };
  } finally {
    clearTimeout(timer);
  }
}

function sha256File(file: string): string | null {
  try {
    return createHash('sha256').update(fsSync.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Enumerate the icons actually present on disk as manifest entries. The
 * manifest is rebuilt from this (NOT just the tokens processed this run)
 * so a `--only=<one>` refresh or a partial run can't silently truncate the
 * other tokens' entries. Only well-formed `<safe-ticker>.<ext>` files are
 * included (defense-in-depth on the basename).
 */
function manifestFromDisk(outDir: string): Array<{ ticker: string; relPath: string }> {
  let files: string[];
  try {
    files = fsSync.readdirSync(outDir);
  } catch {
    return [];
  }
  const out: Array<{ ticker: string; relPath: string }> = [];
  for (const file of files) {
    const m = file.match(/^(.+)\.(png|jpg|webp|gif)$/);
    if (!m || !isSafeTicker(m[1])) continue;
    out.push({ ticker: m[1], relPath: `/token-icons/${file}` });
  }
  return out;
}

function renderManifest(entries: Array<{ ticker: string; relPath: string }>): string {
  const sorted = [...entries].sort((a, b) => a.ticker.localeCompare(b.ticker, 'en'));
  const body = sorted
    .map((e) => `  ${JSON.stringify(e.ticker)}: ${JSON.stringify(e.relPath)},`)
    .join('\n');
  return `/**
 * AUTO-GENERATED by scripts/oracle-mine/scripts/fetch-icons.ts — DO NOT EDIT.
 *
 * Maps each oracle token's canonical ticker to the same-origin path of its
 * baked icon under the Vite \`public/\` root. These icons are served from
 * muhaven.app itself, so the COEP \`require-corp\` header (load-bearing for
 * the FHE WASM's SharedArrayBuffer) does not block them — unlike the
 * third-party rwa.xyz URLs in \`token.icon_url\`.
 *
 * Regenerate after an icon changes: \`npm run fetch:icons\` (then rebuild +
 * push the frontend). No timestamp is emitted, so an unchanged icon set
 * produces a zero-diff re-run.
 */
export const TOKEN_ICON_MANIFEST: Readonly<Record<string, string>> = {
${body}
} as const
`;
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log(`[fetch-icons] mode   : ${args.dryRun ? 'DRY-RUN (no writes)' : 'write'}`);
  console.log(`[fetch-icons] out    : ${args.outDir}`);
  console.log(`[fetch-icons] cap    : ${args.maxBytes} bytes`);

  const sources = args.source === 'api'
    ? await sourceFromApi(args.apiUrl)
    : sourceFromDataDir(args.dataDir);

  let candidates = sources;
  if (args.only) {
    const want = args.only;
    candidates = candidates.filter((s) => want.has(s.ticker));
  }
  if (candidates.length === 0) fail('no tokens to process (check --source / --only).');

  if (!args.dryRun) await fs.mkdir(args.outDir, { recursive: true });

  const manifest: Array<{ ticker: string; relPath: string }> = [];
  let written = 0;
  let unchanged = 0;
  let skippedNoIcon = 0;
  let errors = 0;

  for (const { ticker, url } of candidates) {
    if (!isSafeTicker(ticker)) {
      console.error(`  ✗ ${ticker.slice(0, 40)} — unsafe ticker (not [A-Za-z0-9_-]{1,32}); skipped`);
      errors += 1;
      continue;
    }
    const effectiveUrl = ICON_URL_OVERRIDES[ticker] ?? url;
    if (!effectiveUrl) {
      console.log(`  · ${ticker.padEnd(10)} no icon_url — skipped`);
      skippedNoIcon += 1;
      continue;
    }
    const overridden = ICON_URL_OVERRIDES[ticker] ? ' (override)' : '';
    process.stdout.write(`  ↓ ${ticker.padEnd(10)}${overridden} … `);

    const result = await downloadIcon(ticker, effectiveUrl, args);
    if (!result.ok) {
      console.log(`error: ${result.reason}`);
      errors += 1;
      continue;
    }

    const filename = `${ticker}.${result.ext}`;
    const relPath = `/token-icons/${filename}`;
    const target = path.join(args.outDir, filename);
    manifest.push({ ticker, relPath });

    if (args.dryRun) {
      console.log(`ok ${result.type} ${result.bytes.length}B → ${relPath} (dry-run)`);
      continue;
    }

    // Idempotent write: skip when the on-disk bytes already match.
    if (sha256File(target) === result.sha256) {
      console.log(`ok ${result.type} ${result.bytes.length}B — unchanged`);
      unchanged += 1;
    } else {
      await fs.writeFile(target, result.bytes);
      console.log(`ok ${result.type} ${result.bytes.length}B → ${relPath}`);
      written += 1;
    }

    // Remove any stale sibling left by a prior run in a different format.
    for (const ext of ALL_ICON_EXTS) {
      if (ext === result.ext) continue;
      const stale = path.join(args.outDir, `${ticker}.${ext}`);
      if (fsSync.existsSync(stale)) {
        await fs.rm(stale).catch(() => {});
        console.log(`    removed stale ${ticker}.${ext}`);
      }
    }
  }

  // Build the manifest from everything on disk (not just the tokens
  // processed this run) so a `--only=<one>` refresh or a partial/flaky run
  // can't truncate the other entries. The processed entries are overlaid so
  // a dry-run (which writes nothing to disk) still reports the would-be set.
  const byTicker = new Map<string, string>(
    manifestFromDisk(args.outDir).map((e) => [e.ticker, e.relPath]),
  );
  for (const e of manifest) byTicker.set(e.ticker, e.relPath);
  const finalEntries = [...byTicker].map(([ticker, relPath]) => ({ ticker, relPath }));

  // Regenerate the manifest only when its content actually changes.
  const manifestContent = renderManifest(finalEntries);
  if (args.dryRun) {
    console.log(`[fetch-icons] would write manifest with ${finalEntries.length} entr${finalEntries.length === 1 ? 'y' : 'ies'}`);
  } else {
    const existing = fsSync.existsSync(args.manifestFile)
      ? fsSync.readFileSync(args.manifestFile, 'utf8')
      : null;
    if (existing !== manifestContent) {
      await fs.mkdir(path.dirname(args.manifestFile), { recursive: true });
      await fs.writeFile(args.manifestFile, manifestContent);
      console.log(`[fetch-icons] manifest updated → ${args.manifestFile} (${finalEntries.length} entries)`);
    } else {
      console.log(`[fetch-icons] manifest unchanged (${finalEntries.length} entries)`);
    }
  }

  console.log('');
  console.log(
    `[fetch-icons] done — written: ${written}, unchanged: ${unchanged}, ` +
      `no-icon: ${skippedNoIcon}, errors: ${errors}`,
  );
  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[fetch-icons] uncaught:', err);
  process.exit(1);
});
