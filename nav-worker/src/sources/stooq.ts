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
