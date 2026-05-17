/**
 * Publisher engine — one cycle = visit every managed token, decide
 * whether to publish, and submit setNAV when needed.
 *
 * Wave 3.5 mode: refresh-only. The on-chain NAV value is left untouched;
 * setNAV is called with the existing on-chain value purely to bump
 * `updatedAt`. This is the "manual write" tier per
 * `development/business/PRICE_DATA_SOURCES.md` — appropriate for
 * seed-stage TVL. Real per-asset price publishing is a future Chainlink
 * NAVLink integration that REPLACES this service, not extends it.
 */
import { randomUUID } from 'node:crypto';
import { desc, sql } from 'drizzle-orm';
import { type Address } from 'viem';
import { getConfig, labelToken, type PublishStrategy } from './config.js';
import { getDb } from './db.js';
import { tokenNavHistory } from './schema.js';
import {
  getChain,
  readOracleView,
  submitSetNav,
  ORACLE_ABI,
  type NavView,
} from './chain.js';

export type PublishOutcome =
  | 'published'
  | 'skipped:fresh'
  | 'skipped:wrong-writer'
  | 'skipped:no-db-row'
  | 'skipped:db-stale'
  | 'skipped:strategy'
  | 'skipped:zero-nav'
  | 'error';

export interface TokenStatus {
  token: Address;
  label: string;
  strategy: PublishStrategy;
  /** Latest on-chain `updatedAt` (unix seconds), or null if not read yet. */
  onChainUpdatedAt: number | null;
  onChainNav: string | null;
  onChainIsFresh: boolean | null;
  /** Last DB row's `fetched_at`, or null if no rows for this token. */
  dbLatestFetchedAt: string | null;
  lastSubmitAt: string | null;
  lastSubmitTx: `0x${string}` | null;
  lastOutcome: PublishOutcome | null;
  lastError: string | null;
  /** When the on-chain entry will start reverting StaleNAV (unix sec). */
  nextStaleAt: number | null;
}

export interface CycleResult {
  visited: number;
  published: number;
  skipped: number;
  errors: number;
  errorMessages: string[];
}

const status = new Map<string, TokenStatus>();

function strategyFor(addr: Address): PublishStrategy {
  const config = getConfig();
  const lower = addr.toLowerCase();
  const direct = config.strategies.get(lower);
  if (direct) return direct;
  // Allow strategy keyed by symbol too (case-insensitive).
  const symbol = config.symbols.get(lower);
  if (symbol) {
    const bySymbol = config.strategies.get(symbol.toLowerCase());
    if (bySymbol) return bySymbol;
  }
  return config.defaultStrategy;
}

/**
 * Auto-discover token addresses from the DB if NAV_PUBLISH_TOKENS is empty.
 * Always returns a deduped, lower-cased list.
 */
async function resolveTokens(): Promise<Address[]> {
  const config = getConfig();
  if (config.tokens.length > 0) return config.tokens;
  const db = getDb();
  const rows = await db
    .selectDistinct({ tokenAddress: tokenNavHistory.tokenAddress })
    .from(tokenNavHistory);
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const row of rows) {
    const lower = row.tokenAddress.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower as Address);
  }
  return out;
}

interface DbLatest {
  fetchedAt: Date;
  source: string;
}

/**
 * Source-string prefix used when this service inserts a `token_nav_history`
 * row for a synthetic token (no upstream feed). The prefix lets a future
 * `fetchDbLatest` distinguish "publisher-written row" from "real upstream
 * row" so the synthetic-refresh path keeps re-stamping the same token
 * across cycles without tripping the dbLivenessMs alarm.
 */
const PUBLISHER_SOURCE_PREFIX = 'publisher:synthetic-bootstrap';

async function fetchDbLatest(token: Address): Promise<DbLatest | null> {
  // Case-insensitive match: nav-worker writes addresses in EIP-55
  // checksum case (mixed) while config normalises to lower-case. Postgres
  // `=` on text is byte-exact, so we'd otherwise miss every row.
  const db = getDb();
  const lower = token.toLowerCase();
  const rows = await db
    .select({ fetchedAt: tokenNavHistory.fetchedAt, source: tokenNavHistory.source })
    .from(tokenNavHistory)
    .where(sql`LOWER(${tokenNavHistory.tokenAddress}) = ${lower}`)
    .orderBy(desc(tokenNavHistory.fetchedAt))
    .limit(1);
  if (rows.length === 0) return null;
  return { fetchedAt: rows[0].fetchedAt, source: rows[0].source };
}

/**
 * Format a uint256 NAV (6-decimal base units, e.g. `4545780000n` for
 * $4545.78) as the decimal-price string convention nav-worker uses for
 * the `nav` column ("1", "4545.78", "2400.5"). Backend's
 * `parseDecimalToUsd6` round-trips this back to base units when the
 * quote tool reads.
 */
function navUsd6ToDecimal(navUsd6: bigint): string {
  if (navUsd6 < 0n) {
    throw new Error(`negative NAV cannot be serialised: ${navUsd6}`);
  }
  const padded = navUsd6.toString().padStart(7, '0');
  const intPart = padded.slice(0, -6);
  const fracPart = padded.slice(-6).replace(/0+$/, '');
  return fracPart === '' ? intPart : `${intPart}.${fracPart}`;
}

/**
 * Insert a fresh `token_nav_history` row for a synthetic token (one that
 * has no nav-worker upstream feed — NOVUS / OCEAN / ASTRAT etc.).
 *
 * Why this exists: nav-worker only writes rows for TBILL1 + GOLD1
 * (`nav-worker/src/engine.ts:TOKEN_SOURCES`). Wizard-onboarded synthetic
 * tokens never get a row, so backend's `muhaven_quote` + `muhaven_propose_buy`
 * 404 with "No NAV snapshot indexed". The publisher already knows the
 * authoritative on-chain NAV (it just published it); mirroring that
 * value into `token_nav_history` unblocks the agent surface without
 * adding a parallel writer.
 *
 * Source string carries the {@link PUBLISHER_SOURCE_PREFIX} so the next
 * cycle's `fetchDbLatest` can recognise the row as publisher-owned and
 * keep writing fresh rows past the `dbLivenessMs` window (which would
 * otherwise mis-classify a synthetic token as a stale upstream feed).
 */
async function writeSyntheticNavHistory(token: Address, navUsd6: bigint): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db.insert(tokenNavHistory).values({
    id: randomUUID(),
    tokenAddress: token.toLowerCase(),
    nav: navUsd6ToDecimal(navUsd6),
    apy: null,
    totalAum: null,
    yieldRate: null,
    source: PUBLISHER_SOURCE_PREFIX,
    sourceType: 'manual',
    sourceTimestamp: now,
    fetchedAt: now,
    createdAt: now,
  });
}

function ensureStatus(token: Address): TokenStatus {
  const lower = token.toLowerCase();
  let s = status.get(lower);
  if (!s) {
    const config = getConfig();
    s = {
      token,
      label: labelToken(token, config.symbols),
      strategy: strategyFor(token),
      onChainUpdatedAt: null,
      onChainNav: null,
      onChainIsFresh: null,
      dbLatestFetchedAt: null,
      lastSubmitAt: null,
      lastSubmitTx: null,
      lastOutcome: null,
      lastError: null,
      nextStaleAt: null,
    };
    status.set(lower, s);
  }
  return s;
}

async function readMaxStaleness(token: Address): Promise<bigint> {
  const { publicClient, oracle } = getChain();
  return (await publicClient.readContract({
    address: oracle,
    abi: ORACLE_ABI,
    functionName: 'getMaxStaleness',
    args: [token],
  })) as bigint;
}

async function publishOne(token: Address): Promise<PublishOutcome> {
  const config = getConfig();
  const s = ensureStatus(token);

  const strategy = s.strategy;
  if (strategy === 'skip') {
    s.lastOutcome = 'skipped:strategy';
    s.lastError = null;
    return 'skipped:strategy';
  }

  // Liveness gate — confirm an upstream feed wrote a row recently
  // for tokens that HAVE an upstream feed (TBILL1=FRED yields,
  // GOLD1=commodity price). Synthetic / wizard-deployed RWA tokens
  // (NOVUS / OCEAN / ASTRAT / SUMMIT etc.) have no nav-worker source
  // by design — for those, the "refresh-only" mode still applies
  // (re-stamp the on-chain bootstrap NAV with a fresh `updatedAt`)
  // but the DB-liveness gate is the WRONG check.
  //
  // 2026-05-23 fix: distinguish "no row EVER" (synthetic — bypass
  // liveness gate, fall through to refresh) from "stale row"
  // (nav-worker is broken — keep the skip). The on-chain
  // `view.nav === 0n` check below is the structural backstop for
  // tokens that genuinely have no bootstrap NAV yet (caught by
  // `skipped:zero-nav`).
  //
  // 2026-05-24 follow-up: now that this branch also writes a
  // `token_nav_history` row for synthetic tokens (see
  // `writeSyntheticNavHistory` below — unblocks backend's
  // muhaven_quote / muhaven_propose_buy on wizard-onboarded tokens),
  // subsequent cycles see a non-null `dbLatest` whose source is the
  // publisher itself. Treat that as still-synthetic so we don't
  // mis-fire the dbLivenessMs alarm against our own bookkeeping row
  // and so the next cycle keeps writing fresh rows.
  const dbLatest = await fetchDbLatest(token);
  s.dbLatestFetchedAt = dbLatest?.fetchedAt.toISOString() ?? null;
  const syntheticMode =
    dbLatest === null || dbLatest.source.startsWith(PUBLISHER_SOURCE_PREFIX);
  if (dbLatest === null) {
    // Synthetic token — no upstream feed expected. Log once-per-cycle
    // but DO NOT short-circuit; fall through to the on-chain refresh
    // path so the contract's `updatedAt` keeps bumping past the
    // 36h staleness window. `s.lastError` stays null so the health
    // endpoint doesn't mis-render this as an alarm.
    console.log(
      `[publisher] ${s.label}: no DB row — synthetic refresh mode (using on-chain NAV)`,
    );
  } else if (syntheticMode) {
    // We've been refreshing this synthetic token ourselves. The
    // dbLivenessMs check below is irrelevant here — our cycle interval
    // (~9h) intentionally exceeds liveness gates tuned for nav-worker's
    // hourly cadence. Fall through to the on-chain refresh path.
  } else if (config.dbLivenessMs > 0) {
    const ageMs = Date.now() - dbLatest.fetchedAt.getTime();
    if (ageMs > config.dbLivenessMs) {
      // Real upstream feed exists but is lagging — that's a nav-worker
      // health alarm, not a synthetic-token case. Keep the skip so
      // operators see the staleness in the health endpoint + the
      // Telegram cron-monitor catches it.
      s.lastOutcome = 'skipped:db-stale';
      s.lastError = `latest DB row is ${Math.round(ageMs / 60_000)}min old (gate=${Math.round(config.dbLivenessMs / 60_000)}min)`;
      return 'skipped:db-stale';
    }
  }

  // On-chain inspection.
  let view: NavView;
  try {
    view = await readOracleView(token);
  } catch (err) {
    s.lastOutcome = 'error';
    s.lastError = `oracle read failed: ${(err as Error).message}`;
    return 'error';
  }

  s.onChainNav = view.nav.toString();
  s.onChainUpdatedAt = Number(view.updatedAt);
  s.onChainIsFresh = view.isFresh;

  if (view.nav === 0n) {
    // Fresh deploy or never-seeded token. The publisher refuses to
    // bootstrap NAV — that's `onboard-token.ts`'s job (deviation gate
    // is bypassed only on the first write, which is dangerous to do
    // from an automated cron). Surface as an explicit skip so the
    // health endpoint flags it.
    s.lastOutcome = 'skipped:zero-nav';
    s.lastError = 'oracle has no seed NAV — run scripts/onboard-token.ts';
    return 'skipped:zero-nav';
  }

  const { account } = getChain();
  if (view.navWriter.toLowerCase() !== account.address.toLowerCase()) {
    s.lastOutcome = 'skipped:wrong-writer';
    s.lastError = `signer ${account.address} but navWriter is ${view.navWriter}`;
    return 'skipped:wrong-writer';
  }

  // Synthetic-token bookkeeping. We've confirmed a non-zero on-chain NAV
  // owned by our signer; mirror it into `token_nav_history` so backend's
  // `muhaven_quote` + `muhaven_propose_buy` can find a price for
  // wizard-onboarded tokens that have no nav-worker upstream feed.
  // Runs unconditionally on every synthetic-mode cycle (cheap insert,
  // ~3 rows/day/token; keeps the row fresh regardless of whether we
  // need to publish below). Skipped for tokens with a real upstream feed
  // (`!syntheticMode`) — nav-worker owns those writes. Best-effort: a
  // DB error must NOT mask the on-chain refresh path; log + continue.
  if (syntheticMode) {
    try {
      await writeSyntheticNavHistory(token, view.nav);
      console.log(
        `[publisher] ${s.label}: wrote synthetic nav_history row (nav=${navUsd6ToDecimal(view.nav)})`,
      );
    } catch (err) {
      console.warn(
        `[publisher] ${s.label}: synthetic nav_history insert failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  // Compute the staleness deadline up-front so the health endpoint can
  // surface it whether we publish or skip. Read failures are non-fatal.
  let maxStaleness = 0n;
  try {
    maxStaleness = await readMaxStaleness(token);
    if (maxStaleness > 0n) {
      s.nextStaleAt = Number(view.updatedAt + maxStaleness);
    }
  } catch {
    // ignore — `nextStaleAt` stays at its previous value.
  }

  // refresh-only mode: skip when on-chain timestamp is well within
  // window. Refresh when we're inside the second half of the staleness
  // window so we have a margin even if a cycle gets skipped (the
  // `maxStaleness/4` cadence + skip-when-fresh gives 2 attempts per
  // window).
  if (view.isFresh && maxStaleness > 0n) {
    const ageSec = Math.floor(Date.now() / 1000) - Number(view.updatedAt);
    const halfWindow = Number(maxStaleness) / 2;
    if (ageSec < halfWindow) {
      s.lastOutcome = 'skipped:fresh';
      s.lastError = null;
      return 'skipped:fresh';
    }
    // Past half-window → fall through and refresh.
  }
  // If isFresh==false OR staleness window is unknown → refresh.

  // Refresh: write the existing on-chain value back. The oracle treats
  // `setNAV(token, sameValue)` as a 0-bps move, accepts it through the
  // deviation gate, and bumps `updatedAt`.
  const newNav = view.nav;
  const txHash = await publishWithRetry(token, newNav);

  // Re-read after submit so the health snapshot reflects the new state.
  try {
    const refreshed = await readOracleView(token);
    s.onChainNav = refreshed.nav.toString();
    s.onChainUpdatedAt = Number(refreshed.updatedAt);
    s.onChainIsFresh = refreshed.isFresh;
    if (maxStaleness > 0n) {
      s.nextStaleAt = Number(refreshed.updatedAt + maxStaleness);
    }
  } catch {
    // Non-fatal — values from before the submit remain in the snapshot
    // until the next cycle re-reads.
  }

  s.lastSubmitAt = new Date().toISOString();
  s.lastSubmitTx = txHash;
  s.lastOutcome = 'published';
  s.lastError = null;
  return 'published';
}

/**
 * Submit setNAV with bounded retries. viem's nonce manager re-pulls
 * pending nonces on each `writeContract`, so a transient drop or
 * mempool conflict resolves on the next attempt without operator
 * intervention. Errors after the final attempt bubble to the caller.
 */
async function publishWithRetry(token: Address, newNav: bigint): Promise<`0x${string}`> {
  const config = getConfig();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= config.txRetries; attempt++) {
    try {
      return await submitSetNav(token, newNav, config.txConfirmTimeoutMs);
    } catch (err) {
      lastErr = err;
      const msg = (err as Error)?.message ?? String(err);
      console.warn(
        `[publisher] setNAV(${token}) attempt ${attempt + 1}/${config.txRetries + 1} failed: ${msg}`,
      );
      if (attempt < config.txRetries) {
        // Exponential-ish backoff. Avoids a thundering herd of retries
        // if RPC is briefly down.
        await new Promise((r) => setTimeout(r, config.txRetryDelayMs * (attempt + 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function runPublishCycle(): Promise<CycleResult> {
  const result: CycleResult = { visited: 0, published: 0, skipped: 0, errors: 0, errorMessages: [] };
  const tokens = await resolveTokens();

  if (tokens.length === 0) {
    console.warn('[publisher] no tokens configured and DB has no NAV history rows — nothing to do');
    return result;
  }

  const config = getConfig();
  for (const token of tokens) {
    result.visited++;
    const s = ensureStatus(token);
    s.strategy = strategyFor(token); // re-evaluate in case env was hot-reloaded
    const label = labelToken(token, config.symbols);
    try {
      const outcome = await publishOne(token);
      switch (outcome) {
        case 'published':
          result.published++;
          console.log(`[publisher] ${label}: published (tx=${s.lastSubmitTx})`);
          break;
        case 'error':
          result.errors++;
          if (s.lastError) result.errorMessages.push(`${label}: ${s.lastError}`);
          console.warn(`[publisher] ${label}: error — ${s.lastError}`);
          break;
        default:
          result.skipped++;
          console.log(`[publisher] ${label}: ${outcome}${s.lastError ? ' — ' + s.lastError : ''}`);
      }
    } catch (err) {
      result.errors++;
      const msg = (err as Error).message ?? String(err);
      s.lastOutcome = 'error';
      s.lastError = msg;
      result.errorMessages.push(`${label}: ${msg}`);
      console.error(`[publisher] ${label}: cycle exception:`, err);
    }
  }
  return result;
}

export function getStatusSnapshot(): TokenStatus[] {
  return Array.from(status.values());
}

/**
 * Smallest `nextStaleAt - now` across all known tokens, in seconds.
 * Negative values mean at least one token is currently stale on-chain.
 * Returns null when no token has been inspected yet.
 */
export function nearestStaleSec(): number | null {
  const snaps = Array.from(status.values());
  let best: number | null = null;
  const now = Math.floor(Date.now() / 1000);
  for (const s of snaps) {
    if (s.nextStaleAt === null) continue;
    const delta = s.nextStaleAt - now;
    if (best === null || delta < best) best = delta;
  }
  return best;
}

// Test seam — let unit tests reset cached state.
export function __resetForTests() {
  status.clear();
}
