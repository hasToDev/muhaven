/**
 * FRED API data source — fetches US Treasury yields and SOFR rate.
 *
 * Series used:
 *   DGS3MO — 3-Month Treasury Bill rate (% annual)
 *   SOFR   — Secured Overnight Financing Rate (% annual)
 *
 * API docs: https://fred.stlouisfed.org/docs/api/fred/series_observations.html
 * Rate limit: 120 requests/minute (generous for hourly fetches).
 */
import { getConfig } from '../config.js';

export interface FredObservation {
  date: string; // "YYYY-MM-DD"
  value: number; // percentage, e.g. 4.80
}

interface FredApiResponse {
  observations: Array<{
    date: string;
    value: string; // "4.80" or "."
  }>;
}

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

/**
 * Fetch the latest observation for a FRED series.
 * Returns null if the API is unavailable or the key is missing.
 */
export async function fetchLatestFredObservation(
  seriesId: string,
): Promise<FredObservation | null> {
  const config = getConfig();
  if (!config.fredApiKey) return null;

  const url = new URL(FRED_BASE);
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', config.fredApiKey);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('sort_order', 'desc');
  url.searchParams.set('limit', '1');

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.error(`FRED API error for ${seriesId}: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = (await res.json()) as FredApiResponse;
    const obs = data.observations?.[0];
    if (!obs || obs.value === '.') return null;

    return { date: obs.date, value: parseFloat(obs.value) };
  } catch (err) {
    console.error(`FRED fetch failed for ${seriesId}:`, err);
    return null;
  }
}

/**
 * Fetch multiple observations for backfill (last N days).
 * Returns observations sorted ascending by date.
 */
export async function fetchFredObservations(
  seriesId: string,
  startDate: string, // "YYYY-MM-DD"
): Promise<FredObservation[]> {
  const config = getConfig();
  if (!config.fredApiKey) return [];

  const url = new URL(FRED_BASE);
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', config.fredApiKey);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('observation_start', startDate);
  url.searchParams.set('sort_order', 'asc');

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.error(`FRED API error for ${seriesId} (backfill): ${res.status}`);
      return [];
    }

    const data = (await res.json()) as FredApiResponse;
    return (data.observations ?? [])
      .filter((o) => o.value !== '.')
      .map((o) => ({ date: o.date, value: parseFloat(o.value) }));
  } catch (err) {
    console.error(`FRED backfill fetch failed for ${seriesId}:`, err);
    return [];
  }
}
