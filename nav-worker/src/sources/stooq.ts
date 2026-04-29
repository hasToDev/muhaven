/**
 * stooq.com data source — daily OHLC quotes for commodities, FX,
 * indices, etc.
 *
 * Used for the GOLD1 reference NAV after the FRED `GOLDPMGBD228NLBM`
 * series was archived (LBMA pulled their FRED feed in 2017). Stooq
 * provides XAU/USD daily fixings without an API key or rate limit.
 *
 * Endpoint format:
 *   https://stooq.com/q/l/?s={symbol}&f=sd2t2ohlcv&h&e=csv
 *
 * Response (CSV with one header row + one data row):
 *   Symbol,Date,Time,Open,High,Low,Close,Volume
 *   XAUUSD,2026-04-29,12:34:56,2032.5,2034.1,2030.2,2032.8,0
 *
 * Quirks:
 *   - On weekends/holidays the row carries the most recent trading
 *     day's close — that's the right semantic for a NAV reference
 *     ("last published price").
 *   - `N/D` appears in any cell when stooq has no data; treat the
 *     whole row as null.
 *   - `Volume` is often 0 for FX/commodity quotes — not a failure.
 *   - Times are stooq-server-local (UTC for FX). Defensive parsing
 *     falls back to date-only when the time cell can't be combined
 *     into a valid Date.
 */

export interface StooqObservation {
  symbol: string;
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const STOOQ_BASE = 'https://stooq.com/q/l/';

/**
 * Fetch the latest daily quote. Returns null on network/parse failure
 * or `N/D` data — callers decide the fallback chain.
 */
export async function fetchLatestStooqQuote(
  symbol: string,
): Promise<StooqObservation | null> {
  const url = new URL(STOOQ_BASE);
  url.searchParams.set('s', symbol);
  url.searchParams.set('f', 'sd2t2ohlcv');
  url.searchParams.set('h', '');
  url.searchParams.set('e', 'csv');

  try {
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`stooq error for ${symbol}: ${res.status} ${res.statusText}`);
      return null;
    }
    const text = await res.text();
    return parseStooqCsv(symbol, text);
  } catch (err) {
    console.error(`stooq fetch failed for ${symbol}:`, err);
    return null;
  }
}

export function parseStooqCsv(
  fallbackSymbol: string,
  csv: string,
): StooqObservation | null {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const cells = lines[1].split(',').map((c) => c.trim());
  if (cells.length < 8) return null;

  const [sym, date, time, open, high, low, close, volume] = cells;

  // Stooq returns "N/D" in every column when the symbol is unknown
  // or the most recent observation is missing. A close of "N/D" is
  // the canonical sentinel.
  if (date === 'N/D' || close === 'N/D') return null;

  const closeNum = parseFloat(close);
  if (!Number.isFinite(closeNum) || closeNum <= 0) return null;

  // Combine date + time when time is meaningful; otherwise fall back
  // to date-only (midnight UTC). Stooq emits the server's clock for
  // FX/commodity quotes which is in UTC.
  let observed: Date;
  if (time && time !== 'N/D') {
    const candidate = new Date(`${date}T${time}Z`);
    observed = Number.isNaN(candidate.getTime()) ? new Date(date) : candidate;
  } else {
    observed = new Date(date);
  }

  return {
    symbol: sym && sym !== 'N/D' ? sym : fallbackSymbol,
    date: observed,
    open: safeNum(open),
    high: safeNum(high),
    low: safeNum(low),
    close: closeNum,
    volume: safeNum(volume),
  };
}

function safeNum(s: string | undefined): number {
  if (!s || s === 'N/D') return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fetch daily OHLC history for a stooq symbol over the last `days`
 * trading days. Uses stooq's history-download endpoint:
 *
 *   https://stooq.com/q/d/l/?s={symbol}&d1=YYYYMMDD&d2=YYYYMMDD&i=d
 *
 * Returns observations sorted ascending by date. Empty array on
 * network error or empty response (caller decides fallback).
 *
 * Note: stooq returns trading-day rows only (skips weekends/holidays
 * for FX/commodities, ~22 rows per calendar month for XAUUSD).
 */
export async function fetchStooqHistory(
  symbol: string,
  days: number,
): Promise<StooqObservation[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  const url = new URL('https://stooq.com/q/d/l/');
  url.searchParams.set('s', symbol);
  url.searchParams.set('d1', formatYmd(start));
  url.searchParams.set('d2', formatYmd(end));
  url.searchParams.set('i', 'd');

  try {
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`stooq history error for ${symbol}: ${res.status}`);
      return [];
    }
    const text = await res.text();
    return parseStooqHistoryCsv(symbol, text);
  } catch (err) {
    console.error(`stooq history fetch failed for ${symbol}:`, err);
    return [];
  }
}

/**
 * Parse the history CSV. Format differs from the latest-quote endpoint
 * — no Symbol or Time columns, just `Date,Open,High,Low,Close,Volume`.
 */
export function parseStooqHistoryCsv(
  symbol: string,
  csv: string,
): StooqObservation[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const out: StooqObservation[] = [];
  // Skip header (line 0)
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map((c) => c.trim());
    if (cells.length < 6) continue;
    const [date, open, high, low, close, volume] = cells;
    if (date === 'N/D' || close === 'N/D') continue;
    const closeNum = parseFloat(close);
    if (!Number.isFinite(closeNum) || closeNum <= 0) continue;
    out.push({
      symbol,
      date: new Date(date),
      open: safeNum(open),
      high: safeNum(high),
      low: safeNum(low),
      close: closeNum,
      volume: safeNum(volume),
    });
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function formatYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
