/**
 * Backfill — on first startup, populate 30 days of historical NAV data.
 *
 * - FRED-backed tokens: real historical observations from FRED API
 * - On-chain tokens: synthetic history (current value with small daily variance)
 *
 * Runs once when the token_nav_history table has no entries for a given token.
 */
import { randomUUID } from 'node:crypto';
import { eq, count } from 'drizzle-orm';
import { getDb } from './db.js';
import { tokenNavHistory } from './schema.js';
import { fetchFredObservations } from './sources/fred.js';
import { TOKEN_SOURCES, fredToNav } from './engine.js';
import { getFallbackRate } from './sources/fallback.js';

const BACKFILL_DAYS = 30;

function dateStr(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/**
 * Check if a token has any existing NAV history entries.
 */
async function hasHistory(tokenAddress: string): Promise<boolean> {
  const db = getDb();
  const result = await db
    .select({ n: count() })
    .from(tokenNavHistory)
    .where(eq(tokenNavHistory.tokenAddress, tokenAddress));

  return (result[0]?.n ?? 0) > 0;
}

/**
 * Backfill FRED-based tokens with real historical observations.
 */
async function backfillFredToken(
  tokenAddress: string,
  symbol: string,
  seriesId: string,
): Promise<number> {
  const startDate = dateStr(BACKFILL_DAYS);
  const observations = await fetchFredObservations(seriesId, startDate);

  if (observations.length === 0) {
    console.warn(`[backfill] No FRED data for ${symbol} (${seriesId}) — using synthetic`);
    return backfillSynthetic(tokenAddress, symbol);
  }

  const db = getDb();

  const rows = observations.map((obs) => ({
    id: randomUUID(),
    tokenAddress,
    nav: fredToNav(seriesId, obs.value).toFixed(6),
    apy: obs.value.toString(),
    totalAum: null,
    yieldRate: obs.value.toString(),
    source: `fred:${seriesId}:backfill`,
    sourceType: 'api' as const,
    sourceTimestamp: new Date(obs.date),
    fetchedAt: new Date(obs.date + 'T12:00:00Z'),
    createdAt: new Date(),
  }));

  // Insert in batches of 50
  for (let i = 0; i < rows.length; i += 50) {
    await db.insert(tokenNavHistory).values(rows.slice(i, i + 50));
  }

  console.log(`[backfill] ${symbol}: inserted ${rows.length} FRED observations`);
  return rows.length;
}

/**
 * Backfill with synthetic data — small daily variance around the fallback rate.
 * Used for on-chain tokens or when FRED data is unavailable.
 */
async function backfillSynthetic(tokenAddress: string, symbol: string): Promise<number> {
  const fallback = getFallbackRate(tokenAddress);
  if (!fallback) return 0;

  const db = getDb();
  const rows = [];
  const baseNav = fallback.nav;
  const baseApy = fallback.apy;

  for (let daysAgo = BACKFILL_DAYS; daysAgo >= 1; daysAgo--) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(12, 0, 0, 0);

    // +-0.5% daily variance
    const variance = (Math.random() - 0.5) * 0.01;
    const nav = baseNav * (1 + variance);
    const apy = baseApy + (Math.random() - 0.5) * 0.2;

    rows.push({
      id: randomUUID(),
      tokenAddress,
      nav: nav.toFixed(6),
      apy: apy.toFixed(2),
      totalAum: null,
      yieldRate: apy.toFixed(2),
      source: 'synthetic_backfill',
      sourceType: 'manual' as const,
      sourceTimestamp: d,
      fetchedAt: d,
      createdAt: new Date(),
    });
  }

  for (let i = 0; i < rows.length; i += 50) {
    await db.insert(tokenNavHistory).values(rows.slice(i, i + 50));
  }

  console.log(`[backfill] ${symbol}: inserted ${rows.length} synthetic observations`);
  return rows.length;
}

/**
 * Run backfill for all registered tokens.
 * Only inserts data for tokens that have no existing history.
 */
export async function runBackfill(): Promise<void> {
  console.log('[backfill] Checking for tokens needing historical data...');

  for (const config of TOKEN_SOURCES) {
    if (await hasHistory(config.tokenAddress)) {
      console.log(`[backfill] ${config.symbol}: already has history, skipping`);
      continue;
    }

    if (config.primaryFredSeries) {
      await backfillFredToken(config.tokenAddress, config.symbol, config.primaryFredSeries);
    } else {
      await backfillSynthetic(config.tokenAddress, config.symbol);
    }
  }

  console.log('[backfill] Complete.');
}
