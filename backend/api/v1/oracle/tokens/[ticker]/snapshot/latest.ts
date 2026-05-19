import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GetLatestSnapshotUseCase } from '../../../../../../src/application/use-case/oracle/get-latest-snapshot.use-case.js';
import { container } from '../../../../../../src/infrastructure/container.js';
import { createGetHandler, sendResponse } from '../../../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../../../src/interface/middleware/with-cors.js';
import {
  ORACLE_READ_CACHE_CONTROL,
  validateTicker,
} from '../../../../../../src/interface/oracle/ticker-validator.js';
import { Response } from '../../../../../../src/interface/response.js';

/**
 * GET /api/v1/oracle/tokens/:ticker/snapshot/latest
 *
 * Public read — most-recent point-in-time scalars (NAV / price / APY /
 * supply / holders) for marketplace card hero stats.
 *
 * Numeric fields are returned as strings to preserve the
 * `numeric(N,M)` precision that the DB enforces (JSON's number type
 * is IEEE-754, which would lose precision on 18-decimal supply values).
 */

let _useCase: GetLatestSnapshotUseCase | null = null;
function getUseCase(): GetLatestSnapshotUseCase {
  if (!_useCase) {
    _useCase = new GetLatestSnapshotUseCase(container.oracleRepo);
  }
  return _useCase;
}

const handler = createGetHandler({
  operationName: 'GetLatestSnapshot',
  execute: async (req) => {
    const tickerResult = validateTicker(req.query.ticker);
    if (!tickerResult.ok) return tickerResult.response;
    const result = await getUseCase().execute(tickerResult.value);
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
