import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { GetTimeseriesUseCase } from '../../../../../src/application/use-case/oracle/get-timeseries.use-case.js';
import { container } from '../../../../../src/infrastructure/container.js';
import { createGetHandler, sendResponse } from '../../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../../src/interface/middleware/with-cors.js';
import { okWithCache, validateTicker } from '../../../../../src/interface/oracle/ticker-validator.js';
import { Response } from '../../../../../src/interface/response.js';

/**
 * GET /api/v1/oracle/tokens/:ticker/timeseries?measure=<slug>&from=<iso>&to=<iso>
 *
 * Returns the chart series for one measure of one token, sorted by
 * date ascending. The `measure` query param is required; `from` / `to`
 * are optional ISO `YYYY-MM-DD` bounds (both inclusive).
 *
 * Query params validated at the route layer:
 *  - `measure` matches `^[a-z0-9_]{1,64}$` (same regex as ingest DTO).
 *  - `from` / `to` are strict ISO `YYYY-MM-DD` AND a real calendar
 *    date (Date round-trip check); rejects `2025-13-45` etc. that the
 *    naked regex would accept and Postgres would 500 on.
 *
 * The use case caps the response at 10,000 points and 400s on a
 * larger query — clients must narrow with `from` / `to`. An unknown
 * ticker yields 404 (consistent with metadata + snapshot endpoints).
 *
 * Public read; no auth.
 */

/**
 * Real ISO-date validator — accepts strict `YYYY-MM-DD` AND verifies
 * the calendar (`2026-13-45` fails because round-tripping through
 * `Date` produces a different string). Mirrors the ingest-side
 * `isStrictIsoDate` in `ingest-oracle.use-case.ts`.
 */
function isStrictIsoDate(s: string): boolean {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

const dateField = z.string().refine(isStrictIsoDate, {
  message: 'must be a valid YYYY-MM-DD calendar date',
});

const QuerySchema = z.object({
  measure: z.string().regex(/^[a-z0-9_]{1,64}$/),
  from: dateField.optional(),
  to: dateField.optional(),
});

let _useCase: GetTimeseriesUseCase | null = null;
function getUseCase(): GetTimeseriesUseCase {
  if (!_useCase) {
    _useCase = new GetTimeseriesUseCase(container.oracleRepo);
  }
  return _useCase;
}

const handler = createGetHandler({
  operationName: 'GetTimeseries',
  execute: async (req) => {
    const tickerResult = validateTicker(req.query.ticker);
    if (!tickerResult.ok) return tickerResult.response;

    const parsed = QuerySchema.safeParse({
      measure: req.query.measure,
      from: req.query.from,
      to: req.query.to,
    });
    if (!parsed.success) {
      return Response.fromZodError(parsed.error);
    }
    const result = await getUseCase().execute({
      ticker: tickerResult.value,
      measure_slug: parsed.data.measure,
      ...(parsed.data.from ? { from: parsed.data.from } : {}),
      ...(parsed.data.to ? { to: parsed.data.to } : {}),
    });
    return okWithCache(result);
  },
});

export default withCors(async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'GET') {
    sendResponse(res, Response.badRequest('Method not allowed'));
    return;
  }
  return handler(req, res);
});
