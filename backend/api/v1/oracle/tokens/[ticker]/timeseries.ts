import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GetTimeseriesUseCase } from '../../../../../src/application/use-case/oracle/get-timeseries.use-case.js';
import { container } from '../../../../../src/infrastructure/container.js';
import { createGetHandler, sendResponse } from '../../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../../src/interface/middleware/with-cors.js';
import {
  MEASURE_SLUG_REGEX,
  ORACLE_READ_CACHE_CONTROL,
  ensureSingleString,
  validateTicker,
} from '../../../../../src/interface/oracle/ticker-validator.js';
import { Response } from '../../../../../src/interface/response.js';

/**
 * GET /api/v1/oracle/tokens/:ticker/timeseries?measure=<slug>&from=<iso>&to=<iso>
 *
 * Returns the chart series for one measure of one token, sorted by
 * date ascending. The `measure` query param is required; `from` / `to`
 * are optional ISO `YYYY-MM-DD` bounds (both inclusive).
 *
 * The use case caps the response at 10,000 points and 400s on a
 * larger query — clients must narrow with `from` / `to`. An unknown
 * ticker yields 404 (consistent with metadata + snapshot endpoints).
 *
 * Public read; no auth. Case-insensitive ticker matching at the repo.
 */

/**
 * Real ISO-date validator — accepts strict `YYYY-MM-DD` AND verifies
 * the calendar (`2026-13-45` / `2025-02-30` fail because round-tripping
 * through `Date` produces a different string).
 */
function isStrictIsoDate(s: string): boolean {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

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

    // Each query param is validated with the same single-string +
    // shape check pattern `validateTicker` uses. Doing it manually
    // rather than via Zod gives consistent error messages across the
    // three params (Zod's defaults for "received array" are
    // consumer-hostile). Centralised in `ensureSingleString`.
    const measureRaw = ensureSingleString(req.query.measure, 'measure');
    if (!measureRaw.ok) return measureRaw.response;
    if (!MEASURE_SLUG_REGEX.test(measureRaw.value)) {
      return Response.badRequest(
        'Invalid measure',
        `measure must be lowercase snake_case (e.g. apy_7_day); got ${measureRaw.value}`,
      );
    }

    let from: string | undefined;
    if (req.query.from !== undefined) {
      const check = ensureSingleString(req.query.from, 'from');
      if (!check.ok) return check.response;
      if (!isStrictIsoDate(check.value)) {
        return Response.badRequest(
          'Invalid from',
          `from must be a valid YYYY-MM-DD calendar date; got ${check.value}`,
        );
      }
      from = check.value;
    }

    let to: string | undefined;
    if (req.query.to !== undefined) {
      const check = ensureSingleString(req.query.to, 'to');
      if (!check.ok) return check.response;
      if (!isStrictIsoDate(check.value)) {
        return Response.badRequest(
          'Invalid to',
          `to must be a valid YYYY-MM-DD calendar date; got ${check.value}`,
        );
      }
      to = check.value;
    }

    const result = await getUseCase().execute({
      ticker: tickerResult.value,
      measure_slug: measureRaw.value,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
    return Response.ok(result, { cacheControl: ORACLE_READ_CACHE_CONTROL });
  },
});

export default withCors(async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendResponse(res, Response.methodNotAllowed('GET, HEAD, OPTIONS'));
    return;
  }
  return handler(req, res);
});

