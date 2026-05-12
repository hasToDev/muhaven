/**
 * NAV Engine — orchestrates fetching from sources and writing to DB.
 *
 * Maps registered tokens → data sources. For each token:
 *   1. Try primary source
 *   2. Fall back to secondary source
 *   3. Fall back to static rates
 *
 * Dedup: skip write if latest DB entry has same NAV (0.01% tolerance) and APY (0.01pp threshold).
 */
import { randomUUID } from 'node:crypto';
import { eq, desc, sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { tokenNavHistory } from './schema.js';
import { fetchLatestFredObservation } from './sources/fred.js';
import { fetchLatestStooqQuote } from './sources/stooq.js';
import { fetchBuidlNav, fetchUsdyPrice } from './sources/onchain.js';
import { getFallbackRate } from './sources/fallback.js';

export interface NavSnapshot {
  tokenAddress: string;
  nav: number;
  apy: number | null;
  totalAum: number | null;
  yieldRate: number | null;
  source: string;
  sourceType: 'on_chain' | 'api' | 'manual';
  sourceTimestamp: Date | null;
}

interface TokenSourceConfig {
  tokenAddress: string;
  symbol: string;
  primaryFredSeries?: string;
  /**
   * stooq.com symbol (e.g. `XAUUSD`, `XAGUSD`). When set, the engine
   * pulls the latest daily close as a price-like NAV. Used for assets
   * that lack a maintained FRED series (the FRED `GOLDPMGBD228NLBM`
   * gold-fix series was archived in 2017).
   */
  primaryStooqSymbol?: string;
  primaryOnChain?: () => Promise<{ value: number; timestamp: Date; aum?: number } | null>;
}

/**
 * Token → source mapping for the Wave 3.5 reference-rate cron.
 *
 * Addresses are env-driven and REQUIRED at boot: missing or zero-address
 * values throw at module load so the worker fails loud (Docker restart-loop
 * with the FATAL message in stderr) instead of silently writing NAV rows
 * to dead addresses. The source-of-truth defaults live in
 * `nav-worker/.env.example`, not in this file — no hardcoded fallbacks.
 */
function isValidAddress(addr: unknown): addr is string {
  return (
    typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr) && !/^0x0+$/.test(addr)
  );
}

function requireEnvAddress(name: string): string {
  const value = process.env[name];
  if (!isValidAddress(value)) {
    throw new Error(
      `[nav-worker] FATAL: ${name} is required and must be a non-zero EVM address ` +
        `(got: ${JSON.stringify(value)}). ` +
        `Set in nav-worker/.env from ` +
        `\`deployments/arb-sepolia-v2*.json#tokens.{TBILL1|GOLD1}.contracts.MuHavenToken.proxy\`. ` +
        `If you just edited the env file, restart the container with ` +
        `\`docker compose up -d --force-recreate nav-worker\` — ` +
        `\`docker compose restart\` does NOT pick up env_file changes (the env block is ` +
        `locked at container create).`,
    );
  }
  return value;
}

const TOKEN_SOURCES: TokenSourceConfig[] = [
  {
    tokenAddress: requireEnvAddress('NAV_TBILL1_ADDRESS'),
    symbol: 'TBILL1',
    primaryFredSeries: 'DGS3MO', // 3-month Treasury Bill rate
  },
  {
    tokenAddress: requireEnvAddress('NAV_GOLD1_ADDRESS'),
    symbol: 'GOLD1',
    // XAU/USD daily fixing in USD per troy ounce, fetched from
    // stooq.com (no API key, no rate limit). Stored as a price-like
    // NAV. The FRED `GOLDPMGBD228NLBM` series this used to consume
    // was archived in 2017 when LBMA pulled their feed.
    primaryStooqSymbol: 'XAUUSD',
  },
];

/**
 * Check if the new snapshot is within tolerance of the latest DB entry.
 * Compares both NAV and APY — coupon tokens have constant NAV but changing rates.
 * Returns true if the write should be skipped (values are the same).
 */
async function shouldDedup(tokenAddress: string, newNav: number, newApy: number | null): Promise<boolean> {
  const db = getDb();
  const latest = await db
    .select({ nav: tokenNavHistory.nav, apy: tokenNavHistory.apy })
    .from(tokenNavHistory)
    .where(eq(tokenNavHistory.tokenAddress, tokenAddress))
    .orderBy(desc(tokenNavHistory.fetchedAt))
    .limit(1);

  if (latest.length === 0) return false;

  const existingNav = parseFloat(latest[0].nav);
  const existingApy = latest[0].apy ? parseFloat(latest[0].apy) : null;

  // Guard against division by zero
  const navChanged = existingNav === 0
    ? newNav !== 0
    : Math.abs(newNav - existingNav) / existingNav >= 0.0001;

  // APY comparison: if either is null, they must both be null to match
  const apyChanged = newApy !== null && existingApy !== null
    ? Math.abs(newApy - existingApy) >= 0.01 // 0.01 percentage point threshold
    : newApy !== existingApy;

  return !navChanged && !apyChanged;
}

/**
 * Write a NAV snapshot to the database.
 */
async function writeSnapshot(snapshot: NavSnapshot): Promise<void> {
  const db = getDb();
  const now = new Date();

  await db.insert(tokenNavHistory).values({
    id: randomUUID(),
    tokenAddress: snapshot.tokenAddress,
    nav: snapshot.nav.toString(),
    apy: snapshot.apy?.toString() ?? null,
    totalAum: snapshot.totalAum?.toString() ?? null,
    yieldRate: snapshot.yieldRate?.toString() ?? null,
    source: snapshot.source,
    sourceType: snapshot.sourceType,
    sourceTimestamp: snapshot.sourceTimestamp,
    fetchedAt: now,
    createdAt: now,
  });
}

/**
 * Bump `fetched_at` on the latest row for a token without writing a
 * new snapshot. Called when dedup decides the value is unchanged but
 * we still want downstream consumers (notably nav-publisher's
 * liveness gate) to know the upstream feed is alive. Case-insensitive
 * on `token_address` to match historical writes that used checksum case.
 */
async function bumpLatestFetchedAt(tokenAddress: string): Promise<void> {
  const db = getDb();
  const lower = tokenAddress.toLowerCase();
  const now = new Date();
  await db.execute(sql`
    UPDATE token_nav_history
    SET fetched_at = ${now}
    WHERE id = (
      SELECT id FROM token_nav_history
      WHERE LOWER(token_address) = ${lower}
      ORDER BY fetched_at DESC
      LIMIT 1
    )
  `);
}

// Map on-chain functions to readable source names
const ON_CHAIN_SOURCE_NAMES = new Map<Function, string>([
  [fetchBuidlNav, 'onchain:buidl'],
  [fetchUsdyPrice, 'onchain:usdy'],
]);

/**
 * Derive NAV from a FRED data series. Three series families:
 *   - Coupon-like (treasuries, bonds, mortgages): NAV stays at par (~1.0),
 *     rate is the yield (stored separately in apy/yieldRate).
 *   - Accruing (money market / SOFR): NAV grows with accumulated yield.
 *   - Price-like (gold, commodities): rate IS the price — store raw.
 *     Wave 3.5 GOLD1 reference; the on-chain oracle still provides the
 *     authoritative purchase/redeem NAV, so the unit mismatch with par
 *     tokens is acceptable for the marketplace display.
 */
export function fredToNav(series: string, rate: number): number {
  const accruingSeries = ['SOFR'];
  const priceLikeSeries = ['GOLDPMGBD228NLBM'];

  if (accruingSeries.includes(series)) {
    return 1 + rate / 100 / 12; // Simplified monthly accrual
  }
  if (priceLikeSeries.includes(series)) {
    return rate; // Raw spot price (USD per troy oz for gold)
  }
  return 1.0; // Coupon-paying: NAV stays at par
}

/**
 * Fetch NAV for a single token, trying sources in priority order.
 */
async function fetchTokenNav(config: TokenSourceConfig): Promise<NavSnapshot | null> {
  // 1. Try primary source — FRED API or on-chain
  if (config.primaryFredSeries) {
    const obs = await fetchLatestFredObservation(config.primaryFredSeries);
    if (obs) {
      return {
        tokenAddress: config.tokenAddress,
        nav: fredToNav(config.primaryFredSeries, obs.value),
        apy: obs.value,
        totalAum: null,
        yieldRate: obs.value,
        source: `fred:${config.primaryFredSeries}`,
        sourceType: 'api',
        sourceTimestamp: new Date(obs.date),
      };
    }
  }

  if (config.primaryStooqSymbol) {
    const obs = await fetchLatestStooqQuote(config.primaryStooqSymbol);
    if (obs) {
      // Stooq quotes are raw prices — used as price-like NAV. APY/yield
      // do not apply (commodities have no coupon); leave null.
      return {
        tokenAddress: config.tokenAddress,
        nav: obs.close,
        apy: null,
        totalAum: null,
        yieldRate: null,
        source: `stooq:${config.primaryStooqSymbol}`,
        sourceType: 'api',
        sourceTimestamp: obs.date,
      };
    }
  }

  if (config.primaryOnChain) {
    const result = await config.primaryOnChain();
    if (result) {
      return {
        tokenAddress: config.tokenAddress,
        nav: result.value,
        apy: null,
        totalAum: result.aum ?? null,
        yieldRate: null,
        source: ON_CHAIN_SOURCE_NAMES.get(config.primaryOnChain) ?? 'onchain:unknown',
        sourceType: 'on_chain',
        sourceTimestamp: result.timestamp,
      };
    }
  }

  // 2. Fallback to static rates
  const fallback = getFallbackRate(config.tokenAddress);
  if (fallback) {
    return {
      tokenAddress: config.tokenAddress,
      nav: fallback.nav,
      apy: fallback.apy,
      totalAum: null,
      yieldRate: fallback.apy,
      source: fallback.source,
      sourceType: 'manual',
      sourceTimestamp: null,
    };
  }

  return null;
}

export interface FetchCycleResult {
  fetched: number;
  written: number;
  skipped: number;
  errors: number;
}

/**
 * Cross-check every configured `TOKEN_SOURCES.tokenAddress` against the
 * indexer's `rwa_tokens` registry. A miss means the cron is about to
 * write NAV rows for an orphan address — visible only as silent
 * "No NAV snapshot indexed for SYMBOL" failures from `muhaven_quote`,
 * because `nav_history` lookups are token-address-keyed. Catches the
 * env-vars-set-but-token-not-yet-onboarded case (fresh redeploy + env
 * rotated but `pnpm seed:tokens:v35` not yet run), which the boot-throw
 * in this file's TOKEN_SOURCES block cannot.
 *
 * Probe is best-effort: a DB error doesn't abort startup (the worker
 * still cycles through all sources; missing NAV rows just won't
 * surface in `muhaven_quote` until the operator notices).
 */
export async function probeTokenRegistration(): Promise<void> {
  if (TOKEN_SOURCES.length === 0) {
    console.log('[probe] no TOKEN_SOURCES configured — skipping registration check');
    return;
  }
  try {
    const db = getDb();
    for (const config of TOKEN_SOURCES) {
      const lower = config.tokenAddress.toLowerCase();
      const rows = await db.execute<{ symbol: string; status: string }>(sql`
        SELECT symbol, status FROM rwa_tokens
        WHERE LOWER(address) = ${lower}
        LIMIT 1
      `);
      const row = rows.rows?.[0];
      if (!row) {
        console.warn(
          `[probe] WARNING: ${config.symbol} configured at ${config.tokenAddress} has NO matching row in rwa_tokens. ` +
            `Quote tool will fail with "No NAV snapshot indexed" for this symbol. ` +
            `Likely cause: NAV_${config.symbol}_ADDRESS points at a token that hasn't been onboarded yet, ` +
            `or the deployments file has rotated since the worker container was created. ` +
            `Fix: confirm NAV_${config.symbol}_ADDRESS in nav-worker/.env matches the live address from deployments/arb-sepolia-v2*.json, ` +
            `then \`docker compose up -d --force-recreate nav-worker\` (NOT \`restart\`).`,
        );
      } else if (row.symbol !== config.symbol) {
        console.warn(
          `[probe] WARNING: ${config.tokenAddress} resolves to symbol="${row.symbol}" in rwa_tokens but NAV cron has it as ${config.symbol}. Symbol/address mismatch.`,
        );
      } else {
        console.log(
          `[probe] ${config.symbol}: ${config.tokenAddress} → rwa_tokens row OK (status=${row.status})`,
        );
      }
    }
  } catch (err) {
    console.warn(
      '[probe] registration probe failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Run one full fetch cycle for all registered tokens.
 */
export async function runFetchCycle(): Promise<FetchCycleResult> {
  const result: FetchCycleResult = { fetched: 0, written: 0, skipped: 0, errors: 0 };

  for (const config of TOKEN_SOURCES) {
    try {
      const snapshot = await fetchTokenNav(config);
      if (!snapshot) {
        console.warn(`No data available for ${config.symbol} — all sources failed`);
        result.errors++;
        continue;
      }

      result.fetched++;

      // Dedup check. We still bump `fetched_at` on the existing latest
      // row so downstream consumers (nav-publisher liveness gate) can
      // distinguish "feed silent" from "feed returning stable values".
      if (await shouldDedup(snapshot.tokenAddress, snapshot.nav, snapshot.apy)) {
        await bumpLatestFetchedAt(snapshot.tokenAddress);
        console.log(`[dedup] ${config.symbol}: NAV=${snapshot.nav}, APY=${snapshot.apy ?? 'n/a'} unchanged, bumped fetched_at`);
        result.skipped++;
        continue;
      }

      await writeSnapshot(snapshot);
      console.log(
        `[write] ${config.symbol}: NAV=${snapshot.nav}, APY=${snapshot.apy ?? 'n/a'}, source=${snapshot.source}`,
      );
      result.written++;
    } catch (err) {
      console.error(`Error fetching ${config.symbol}:`, err);
      result.errors++;
    }
  }

  return result;
}

export { TOKEN_SOURCES };
