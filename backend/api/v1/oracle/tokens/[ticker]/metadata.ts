import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GetTokenMetadataUseCase } from '../../../../../src/application/use-case/oracle/get-token-metadata.use-case.js';
import { container } from '../../../../../src/infrastructure/container.js';
import { createGetHandler, sendResponse } from '../../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../../src/interface/middleware/with-cors.js';
import {
  ORACLE_READ_CACHE_CONTROL,
  validateTicker,
} from '../../../../../src/interface/oracle/ticker-validator.js';
import { Response } from '../../../../../src/interface/response.js';

/**
 * GET /api/v1/oracle/tokens/:ticker/metadata
 *
 * Public read — marketplace cards + token detail page consume this for
 * display strings. The returned `is_yield_bearing` is the EFFECTIVE
 * flag (`override ?? rwaxyz_flag`); the raw rwa.xyz value is exposed
 * alongside as `is_yield_bearing_rwaxyz` for transparency.
 *
 * No auth — same posture as `GET /api/v1/tokens` (marketplace catalog).
 * Ticker is validated + matched case-insensitively against the
 * `token_metadata.ticker` PK.
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
    return Response.ok(result, { cacheControl: ORACLE_READ_CACHE_CONTROL });
  },
});

export default withCors(async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  // HEAD ↔ GET — clients (health checkers, link probes, CDN warmers)
  // routinely HEAD before GET; RFC 7231 §4.3.2 requires HEAD-supports
  // wherever GET is supported. The body is suppressed by the
  // underlying Node http server because it sees `req.method === 'HEAD'`.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendResponse(res, Response.methodNotAllowed('GET, HEAD, OPTIONS'));
    return;
  }
  return handler(req, res);
});
