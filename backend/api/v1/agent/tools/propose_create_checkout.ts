import { Surface } from '../../../../src/domain/agent/model/surface.enum.js';
import { ProposeCreateCheckoutDtoSchema } from '../../../../src/application/dto/agent/issuer-tool.dto.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler } from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../src/interface/response.js';

/**
 * Wave 4 §5 Path C — POST /api/v1/agent/tools/propose_create_checkout.
 *
 * Issuer-side write tool. Device-flow JWTs need `mcp.propose.*`; SIWE
 * tokens fall through (legacy unscoped = all-scopes). Lifecycle gate +
 * token-issuer-of-record check happen inside the use-case.
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

export default withCors(withAuth(withScope(['mcp.propose.*'])(handler)));
