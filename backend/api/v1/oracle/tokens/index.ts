import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GetTokenListUseCase } from '../../../../src/application/use-case/oracle/get-token-list.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createGetHandler, sendResponse } from '../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { ORACLE_READ_CACHE_CONTROL } from '../../../../src/interface/oracle/ticker-validator.js';
import { Response } from '../../../../src/interface/response.js';

/**
 * GET /api/v1/oracle/tokens
 *
 * Public read — full marketplace catalog of oracle-tracked tokens with
 * latest snapshot inlined per row. Bounded by the catalog size; no
 * pagination today.
 *
 * Auth: none. Same posture as `GET /api/v1/tokens` and the sibling
 * per-ticker reads.
 *
 * Caching: matches the per-ticker `Cache-Control` so the marketplace
 * page hits a single edge entry instead of 11 separate ones.
 */

let _useCase: GetTokenListUseCase | null = null;
function getUseCase(): GetTokenListUseCase {
  if (!_useCase) {
    _useCase = new GetTokenListUseCase(container.oracleRepo);
  }
  return _useCase;
}

const handler = createGetHandler({
  operationName: 'GetTokenList',
  execute: async () => {
    const result = await getUseCase().execute();
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
