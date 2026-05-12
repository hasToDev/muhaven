import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Surface } from '../../../../src/domain/agent/model/surface.enum.js';
import { ProposeCreateCheckoutDtoSchema } from '../../../../src/application/dto/agent/issuer-tool.dto.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withRole } from '../../../../src/interface/middleware/with-role.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../src/interface/response.js';

/**
 * Wave 4 §5 Path C — POST /api/v1/agent/tools/propose_create_checkout.
 *
 * Issuer-side write tool with defense-in-depth:
 *   1. `withScope(['mcp.propose.*'])` — device-flow JWTs.
 *   2. `withRole('issuer')` — refuses non-issuer JWTs at the HTTP
 *      boundary; the use-case re-checks role + lifecycle, but route-level
 *      gating means an investor JWT cannot even hit the dispatcher.
 *
 * (Sec-review HIGH-2 fix — prior version only had `withScope`, which let
 * an investor JWT reach the use-case and burn its 423/403 path.)
 */
const handler = createHandler({
  operationName: 'AgentToolProposeCreateCheckout',
  schema: ProposeCreateCheckoutDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const result = await container.toolDispatcher.dispatch(
      {
        userId: authPayload!.userId,
        walletAddress: authPayload!.walletAddress,
        surface: Surface.HavenBot,
      },
      'muhaven_propose_create_checkout',
      dto,
    );
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

export default withCors(
  withAuth(withScope(['mcp.propose.*'])(withRole('issuer', router))),
);
