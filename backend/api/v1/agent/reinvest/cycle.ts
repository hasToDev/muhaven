import type { VercelRequest, VercelResponse } from '@vercel/node';
import { container } from '../../../../src/infrastructure/container.js';
import {
  createHandler,
  sendResponse,
} from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../src/interface/response.js';
import { RecordReinvestCycleRequestDtoSchema } from '../../../../src/application/dto/agent/reinvest.dto.js';

/**
 * POST /api/v1/agent/reinvest/cycle
 *
 * Wave 5 Slice 2c — the keyless `muhaven-reinvest` runner records a
 * completed reinvest cycle (atomic claim+buy in one UserOp) as a WORM
 * audit row. Body = the cleartext structural facts (epoch, token,
 * snapshot, userOpHash/txHash, buyShares, budgetUsd6); the claimed amount
 * stays encrypted (amount-blind). Revoke-gated + idempotent per
 * `(user, epoch)`. Scope `mcp.propose.*` (a state write); the runner
 * carries the same broker device-flow JWT the MCP propose tools use.
 * `userId` is derived from the verified JWT subject, NOT the body.
 */
const handler = createHandler({
  operationName: 'RecordReinvestCycle',
  schema: RecordReinvestCycleRequestDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const result = await container.recordReinvestCycle.execute({
      userId: authPayload!.userId,
      ...dto,
    });
    return Response.ok(result);
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'POST') {
    sendResponse(res, Response.badRequest('Method not allowed'));
    return;
  }
  return handler(req, res);
};

export default withCors(withAuth(withScope(['mcp.propose.*'])(router)));
