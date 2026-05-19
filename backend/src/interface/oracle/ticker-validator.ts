import type { HttpResponse } from '../response.js';
import { Response } from '../response.js';

/**
 * Wave 5 Q1 — shared shape contract between oracle read endpoints
 * and the ingest DTO. Centralised so the three read endpoints can't
 * drift apart on input shape, and so the regex stays in sync with
 * `application/dto/oracle/oracle-ingest.dto.ts`.
 */

export const TICKER_REGEX = /^[A-Za-z0-9_-]{1,32}$/;

export type TickerCheck =
  | { ok: true; value: string }
  | { ok: false; response: HttpResponse };

/**
 * Validates a `req.query.ticker` value. Rejects arrays
 * (`?ticker=a&ticker=b`) and anything that doesn't match the regex.
 */
export function validateTicker(raw: unknown): TickerCheck {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      response: Response.badRequest(
        'Invalid ticker',
        raw === undefined ? 'ticker is required' : 'ticker must be a single string',
      ),
    };
  }
  if (!TICKER_REGEX.test(raw)) {
    return {
      ok: false,
      response: Response.badRequest(
        'Invalid ticker',
        `ticker must match ${TICKER_REGEX.source}`,
      ),
    };
  }
  return { ok: true, value: raw };
}

/**
 * Wraps a 200 response with explicit `Cache-Control` so a CDN/proxy
 * applies the intended policy rather than its default. Oracle reads
 * are deterministic given URL + query; 60s edge cache absorbs
 * marketplace render-burst without staling the data more than the
 * 8h refresh cadence.
 */
export function okWithCache(data: unknown): HttpResponse {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=120',
    },
    body: JSON.stringify(data),
  };
}
