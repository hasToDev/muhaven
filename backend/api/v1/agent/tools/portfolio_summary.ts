import { Surface } from '../../../../src/domain/agent/model/surface.enum.js';
import { PortfolioSummaryDtoSchema } from '../../../../src/application/dto/agent/tool.dto.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler } from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../src/interface/response.js';

const handler = createHandler({
  operationName: 'AgentToolPortfolioSummary',
  schema: PortfolioSummaryDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const result = await container.toolDispatcher.dispatch(
      {
        userId: authPayload!.userId,
        walletAddress: authPayload!.walletAddress,
        surface: Surface.HavenBot,
      },
      'muhaven_portfolio_summary',
      dto,
    );
    return Response.ok(result);
  },
});

// Wave 4 P2 — read-side tool. Device-flow JWTs need `mcp.read.*`;
// SIWE tokens fall through (legacy unscoped = all-scopes).
export default withCors(withAuth(withScope(['mcp.read.*'])(handler)));
