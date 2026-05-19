import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GetTokenMetadataUseCase } from '../../../../../src/application/use-case/oracle/get-token-metadata.use-case.js';
import { container } from '../../../../../src/infrastructure/container.js';
import { createGetHandler, sendResponse } from '../../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../../src/interface/middleware/with-cors.js';
import { okWithCache, validateTicker } from '../../../../../src/interface/oracle/ticker-validator.js';
import { Response } from '../../../../../src/interface/response.js';

/**
 * GET /api/v1/oracle/tokens/:ticker/metadata
 *
 * Public read — marketplace cards + token detail page consume this for
 * display strings (issuer / asset class / fees / regulatory framework
 * / primary-market terms). The returned `is_yield_bearing` is the
 * EFFECTIVE flag (`override ?? rwaxyz_flag`); the raw rwa.xyz value is
 * exposed alongside as `is_yield_bearing_rwaxyz` for transparency.
 *
 * No auth — same posture as `GET /api/v1/tokens` (marketplace catalog).
 * No PII; the data is rwa.xyz's public scrape.
 *
 * Ticker is validated against the same regex the ingest DTO enforces
 * at write time, so malformed input is rejected with 400 before it
 * reaches the DB.
 */

let _useCase: GetTokenMetadataUseCase | null = null;
function getUseCase(): GetTokenMetadataUseCase {
  if (!_useCase) {
    _useCase = new GetTokenMetadataUseCase(container.oracleRepo);
  }
  return _useCase;
}

const handler = createGetHandler({
  operationName: 'GetTokenMetadata',
  execute: async (req) => {
    const tickerResult = validateTicker(req.query.ticker);
    if (!tickerResult.ok) return tickerResult.response;
    const result = await getUseCase().execute(tickerResult.value);
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
