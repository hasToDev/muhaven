import { Surface } from '../../../../src/domain/agent/model/surface.enum.js';
import { ProposeGovernanceVoteDtoSchema } from '../../../../src/application/dto/agent/p11-tool.dto.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler } from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../src/interface/response.js';

const handler = createHandler({
  operationName: 'AgentToolProposeGovernanceVote',
  schema: ProposeGovernanceVoteDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const result = await container.toolDispatcher.dispatch(
      {
        userId: authPayload!.userId,
        walletAddress: authPayload!.walletAddress,
        surface: Surface.HavenBot,
      },
      'muhaven_propose_governance_vote',
      dto,
    );
    return Response.ok(result);
  },
});

// Wave 4 P11 — propose tool: tier-gated state-mutating action.
export default withCors(withAuth(withScope(['mcp.propose.*'])(handler)));
