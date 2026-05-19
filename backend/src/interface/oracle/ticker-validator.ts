import type { HttpResponse } from '../response.js';
import { Response } from '../response.js';

/**
 * Wave 5 Q1 — shared shape contracts for oracle read endpoints.
 * Centralised so the three routes can't drift apart on input shape,
 * and so the regex stays in sync with
 * `application/dto/oracle/oracle-ingest.dto.ts`.
 */

export const TICKER_REGEX = /^[A-Za-z0-9_-]{1,32}$/;
export const MEASURE_SLUG_REGEX = /^[a-z0-9_]{1,64}$/;

/**
 * Edge cache + browser cache tuned to the 8h oracle refresh cadence.
 *   - `s-maxage=3600` lets Cloudflare hold an edge entry for 1h, so
 *     the origin sees one refresh per (PoP × ticker × endpoint × hour)
 *     instead of ~60×/hour.
 *   - `stale-while-revalidate=28800` (8h) lets CF serve stale-but-valid
 *     responses immediately while a background revalidate runs — covers
 *     the gap between the s-maxage expiry and the next scheduled
 *     ingest.
 *   - `max-age=300` keeps browser-side caching short so a manual reload
 *     in a few minutes shows fresher data.
 */
export const ORACLE_READ_CACHE_CONTROL =
  'public, max-age=300, s-maxage=3600, stale-while-revalidate=28800';

export type Check<T> = { ok: true; value: T } | { ok: false; response: HttpResponse };

/**
 * Validates a `req.query.<param>` value as a single string. Rejects
 * arrays (`?p=a&p=b`) and non-strings consistently across the three
 * read endpoints. Used by `ticker`; the timeseries route additionally
 * applies regex checks via Zod for the other params.
 */
export function ensureSingleString(
  raw: unknown,
  paramName: string,
): Check<string> {
  if (Array.isArray(raw)) {
    return {
      ok: false,
      response: Response.badRequest(
        `Invalid ${paramName}`,
        `${paramName} must be a single string (received an array)`,
      ),
    };
  }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      response: Response.badRequest(
        `Invalid ${paramName}`,
        raw === undefined
          ? `${paramName} is required`
          : `${paramName} must be a single string`,
      ),
    };
  }
  return { ok: true, value: raw };
}

/**
 * Validates a `req.query.ticker` value: single string + matches the
 * ingest-DTO regex. Centralised so the three read endpoints can't
 * drift apart on input shape.
 */
export function validateTicker(raw: unknown): Check<string> {
  const singleCheck = ensureSingleString(raw, 'ticker');
  if (!singleCheck.ok) return singleCheck;
  if (!TICKER_REGEX.test(singleCheck.value)) {
    return {
      ok: false,
      response: Response.badRequest(
        'Invalid ticker',
        `ticker must match ${TICKER_REGEX.source}`,
      ),
    };
  }
  return { ok: true, value: singleCheck.value };
}
