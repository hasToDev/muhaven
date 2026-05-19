import type { VercelRequest, VercelResponse } from '@vercel/node';
import { OracleIngestRequestSchema } from '../../../../src/application/dto/oracle/oracle-ingest.dto.js';
import { IngestOracleUseCase } from '../../../../src/application/use-case/oracle/ingest-oracle.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withServiceSecret } from '../../../../src/interface/middleware/with-service-secret.js';
import { Response } from '../../../../src/interface/response.js';

/**
 * POST /api/v1/admin/oracle/ingest — Wave 5 Q1 RWA oracle ingest.
 *
 * Auth: shared service secret in `Authorization: Bearer <secret>`. The
 * operator script (`backend/scripts/ingest-oracle.ts`) holds
 * `ORACLE_INGEST_SERVICE_SECRET`. NOT a user-facing endpoint — the
 * 8-hour refresh cron + first ingest are operator-driven from the dev
 * machine.
 *
 * Body: `{ assets: OracleAssetPayload[] }` — the per-token JSON files
 * written by `development/ORACLE_DATA_MINE/scripts/extract-asset.ts`.
 * Per-token failures DO NOT abort the batch — the response carries a
 * per-token status list so the operator can re-run just the failing
 * tickers.
 */
const useCase = new IngestOracleUseCase(container.oracleRepo);

const handler = createHandler({
  operationName: 'IngestOracle',
  schema: OracleIngestRequestSchema,
  execute: async (dto) => {
    const result = await useCase.execute(dto.assets);
    return Response.ok(result);
  },
});

const protectedHandler = withServiceSecret(
  { envVar: 'ORACLE_INGEST_SERVICE_SECRET', serviceName: 'Oracle Ingest' },
  handler,
);

export default withCors(async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'POST') {
    sendResponse(res, Response.badRequest('Method not allowed'));
    return;
  }
  return protectedHandler(req, res);
});
