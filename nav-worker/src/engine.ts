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
import { eq, desc } from 'drizzle-orm';
import { getDb } from './db.js';
import { tokenNavHistory } from './schema.js';
import { fetchLatestFredObservation } from './sources/fred.js';
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
  primaryOnChain?: () => Promise<{ value: number; timestamp: Date; aum?: number } | null>;
}

/**
 * Token → source mapping for the Wave 3.5 reference-rate cron.
 *
 * Addresses are env-driven so staging and prod can populate from their
 * respective deployments (NAV_TBILL1_ADDRESS / NAV_GOLD1_ADDRESS in each
 * env file). Defaults baked in below match the staging deployment in
 * `deployments/arb-sepolia-v2.staging.json` so a fresh dev box works
 * without setup.
 *
 * Tokens with no env override AND a falsey default are filtered out at
 * cycle time so the worker doesn't run against zero-address tokens.
 *
 * Wave 3 history note: this used to list 8 demo placeholders at
 * 0x0000…0001 through 0x0000…0008 — meaningless writes against orphan
 * addresses. Removed in Phase 8 cutover.
 */
const STAGING_TBILL1 = '0x3E570bDb3928488b0092FBE149d4B7E8d12cb178';
const STAGING_GOLD1  = '0x4963e942A846e7F537358fe0CC18C7aA9B554375';

const TOKEN_SOURCES: TokenSourceConfig[] = [
  {
    tokenAddress: process.env.NAV_TBILL1_ADDRESS || STAGING_TBILL1,
    symbol: 'TBILL1',
    primaryFredSeries: 'DGS3MO', // 3-month Treasury Bill rate
  },
  {
    tokenAddress: process.env.NAV_GOLD1_ADDRESS || STAGING_GOLD1,
    symbol: 'GOLD1',
    // London PM gold fix in USD per troy ounce. Stored as a price-like
    // NAV (raw $/oz, not par) — see priceLikeSeries in fredToNav.
    primaryFredSeries: 'GOLDPMGBD228NLBM',
  },
].filter(t => /^0x[0-9a-fA-F]{40}$/.test(t.tokenAddress) && !/^0x0+$/.test(t.tokenAddress));

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

      // Dedup check
      if (await shouldDedup(snapshot.tokenAddress, snapshot.nav, snapshot.apy)) {
        console.log(`[dedup] ${config.symbol}: NAV=${snapshot.nav}, APY=${snapshot.apy ?? 'n/a'} unchanged, skipping write`);
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
