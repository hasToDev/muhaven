/**
 * Backfill — populate up to 30 days of historical NAV data per token.
 *
 * - FRED-backed tokens: real historical observations from FRED API
 * - stooq-backed tokens: real historical OHLC when stooq's history
 *   endpoint is reachable (requires an API key — captcha-gated). When
 *   it isn't, generate a ±0.5% daily-variance chart anchored on the
 *   latest live quote (which uses the no-key endpoint). The live
 *   cycle will replace these synthetic days with real values
 *   organically over the next ~30 hours.
 * - Else: synthetic history around the static fallback rate
 *
 * Idempotent: runs on every nav-worker startup. Reads the set of dates
 * already covered for each token (by `source_timestamp`) and inserts
 * only rows whose date is missing. Self-healing — if a few rows get
 * deleted by an operator, the next restart fills the gap. Skipped
 * entirely when coverage is already at the BACKFILL_DAYS target.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { tokenNavHistory } from './schema.js';
import { fetchFredObservations } from './sources/fred.js';
import { fetchLatestStooqQuote, fetchStooqHistory } from './sources/stooq.js';
import { TOKEN_SOURCES, fredToNav } from './engine.js';
import { getFallbackRate } from './sources/fallback.js';

const BACKFILL_DAYS = 30;

function dateStr(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Set of `YYYY-MM-DD` strings for which we already have a row, keyed
 * off `source_timestamp` (the natural per-day key). Case-insensitive
 * on `token_address` to match nav-worker's checksum-cased writes
 * regardless of how the caller's address is cased.
 */
async function getCoveredDates(tokenAddress: string): Promise<Set<string>> {
  const db = getDb();
  const lower = tokenAddress.toLowerCase();
  const rows = await db
    .select({ sourceTimestamp: tokenNavHistory.sourceTimestamp })
    .from(tokenNavHistory)
    .where(sql`LOWER(${tokenNavHistory.tokenAddress}) = ${lower}`);
  const out = new Set<string>();
  for (const r of rows) {
    if (r.sourceTimestamp) out.add(ymd(r.sourceTimestamp));
  }
  return out;
}

/**
 * Backfill FRED-based tokens with real historical observations,
 * skipping dates already covered.
 */
async function backfillFredToken(
  tokenAddress: string,
  symbol: string,
  seriesId: string,
  covered: Set<string>,
): Promise<number> {
  const startDate = dateStr(BACKFILL_DAYS);
  const observations = await fetchFredObservations(seriesId, startDate);

  if (observations.length === 0) {
    console.warn(`[backfill] No FRED data for ${symbol} (${seriesId}) — using fallback synthetic`);
    return backfillFallbackSynthetic(tokenAddress, symbol, covered);
  }

  const fresh = observations.filter((obs) => !covered.has(obs.date));
  if (fresh.length === 0) {
    console.log(`[backfill] ${symbol}: all ${observations.length} FRED dates already covered`);
    return 0;
  }

  const db = getDb();
  const rows = fresh.map((obs) => ({
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

  for (let i = 0; i < rows.length; i += 50) {
    await db.insert(tokenNavHistory).values(rows.slice(i, i + 50));
  }

  console.log(
    `[backfill] ${symbol}: inserted ${rows.length} FRED observations (skipped ${observations.length - rows.length} already-covered)`,
  );
  return rows.length;
}

/**
 * Backfill stooq-based tokens. Tries the history endpoint first
 * (requires API key, captcha-gated); on empty response, falls back
 * to a ±0.5% daily-variance chart anchored on the latest live quote.
 */
async function backfillStooqToken(
  tokenAddress: string,
  symbol: string,
  stooqSymbol: string,
  covered: Set<string>,
): Promise<number> {
  const observations = await fetchStooqHistory(stooqSymbol, BACKFILL_DAYS);

  if (observations.length > 0) {
    const fresh = observations.filter((obs) => !covered.has(ymd(obs.date)));
    if (fresh.length === 0) {
      console.log(`[backfill] ${symbol}: all ${observations.length} stooq dates already covered`);
      return 0;
    }

    const db = getDb();
    const rows = fresh.map((obs) => ({
      id: randomUUID(),
      tokenAddress,
      nav: obs.close.toFixed(6),
      apy: null,
      totalAum: null,
      yieldRate: null,
      source: `stooq:${stooqSymbol}:backfill`,
      sourceType: 'api' as const,
      sourceTimestamp: obs.date,
      fetchedAt: new Date(`${ymd(obs.date)}T12:00:00Z`),
      createdAt: new Date(),
    }));

    for (let i = 0; i < rows.length; i += 50) {
      await db.insert(tokenNavHistory).values(rows.slice(i, i + 50));
    }

    console.log(
      `[backfill] ${symbol}: inserted ${rows.length} stooq observations (skipped ${observations.length - rows.length} already-covered)`,
    );
    return rows.length;
  }

  // History endpoint returned nothing — most often means the API key
  // gate. Try the no-key live endpoint and synthesise around it.
  console.warn(
    `[backfill] No stooq history for ${symbol} (${stooqSymbol}) — generating anchored-synthetic from live quote`,
  );
  const latest = await fetchLatestStooqQuote(stooqSymbol);
  if (!latest) {
    console.warn(`[backfill] No stooq live quote either — falling through to fallback synthetic`);
    return backfillFallbackSynthetic(tokenAddress, symbol, covered);
  }
  return insertSyntheticRows(
    tokenAddress,
    symbol,
    `stooq:${stooqSymbol}:synthetic`,
    latest.close,
    null,
    covered,
  );
}

/**
 * Generate ±0.5% daily-variance synthetic rows anchored on `baseNav`
 * (and optionally `baseApy`). Skips dates already covered. Returns
 * the number of rows inserted.
 */
async function insertSyntheticRows(
  tokenAddress: string,
  symbol: string,
  source: string,
  baseNav: number,
  baseApy: number | null,
  covered: Set<string>,
): Promise<number> {
  const db = getDb();
  const rows = [];

  for (let daysAgo = BACKFILL_DAYS; daysAgo >= 1; daysAgo--) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(12, 0, 0, 0);
    if (covered.has(ymd(d))) continue;

    const variance = (Math.random() - 0.5) * 0.01;
    const nav = baseNav * (1 + variance);
    const apy = baseApy !== null ? baseApy + (Math.random() - 0.5) * 0.2 : null;

    rows.push({
      id: randomUUID(),
      tokenAddress,
      nav: nav.toFixed(6),
      apy: apy !== null ? apy.toFixed(2) : null,
      totalAum: null,
      yieldRate: apy !== null ? apy.toFixed(2) : null,
      source,
      sourceType: 'manual' as const,
      sourceTimestamp: d,
      fetchedAt: d,
      createdAt: new Date(),
    });
  }

  if (rows.length === 0) {
    console.log(`[backfill] ${symbol}: ${source} dates already covered`);
    return 0;
  }

  for (let i = 0; i < rows.length; i += 50) {
    await db.insert(tokenNavHistory).values(rows.slice(i, i + 50));
  }

  console.log(`[backfill] ${symbol}: inserted ${rows.length} ${source} observations`);
  return rows.length;
}

/**
 * Last-resort synthetic backfill using the static fallback rate from
 * `sources/fallback.ts`. Called when no upstream source is reachable
 * AND the token has a configured fallback. Tokens without one (e.g.
 * GOLD1, which has no fallback rate entry) get nothing.
 */
async function backfillFallbackSynthetic(
  tokenAddress: string,
  symbol: string,
  covered: Set<string>,
): Promise<number> {
  const fallback = getFallbackRate(tokenAddress);
  if (!fallback) {
    console.warn(`[backfill] ${symbol}: no fallback rate configured — leaving empty`);
    return 0;
  }
  return insertSyntheticRows(
    tokenAddress,
    symbol,
    'synthetic_backfill',
    fallback.nav,
    fallback.apy,
    covered,
  );
}

/**
 * Run backfill for all registered tokens. Idempotent — fills only
 * missing dates per token. Skipped entirely when coverage already
 * meets the BACKFILL_DAYS target.
 */
export async function runBackfill(): Promise<void> {
  console.log('[backfill] Checking for tokens needing historical data...');

  for (const config of TOKEN_SOURCES) {
    const covered = await getCoveredDates(config.tokenAddress);
    if (covered.size >= BACKFILL_DAYS) {
      console.log(`[backfill] ${config.symbol}: ${covered.size} days covered, skipping`);
      continue;
    }

    if (config.primaryFredSeries) {
      await backfillFredToken(config.tokenAddress, config.symbol, config.primaryFredSeries, covered);
    } else if (config.primaryStooqSymbol) {
      await backfillStooqToken(config.tokenAddress, config.symbol, config.primaryStooqSymbol, covered);
    } else {
      await backfillFallbackSynthetic(config.tokenAddress, config.symbol, covered);
    }
  }

  console.log('[backfill] Complete.');
}
