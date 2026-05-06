import { Surface } from '../../../../src/domain/agent/model/surface.enum.js';
import { QuoteDtoSchema } from '../../../../src/application/dto/agent/tool.dto.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler } from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../src/interface/response.js';

const handler = createHandler({
  operationName: 'AgentToolQuote',
  schema: QuoteDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const result = await container.toolDispatcher.dispatch(
      {
        userId: authPayload!.userId,
        walletAddress: authPayload!.walletAddress,
        surface: Surface.HavenBot,
      },
      'muhaven_quote',
      dto,
    );
    return Response.ok(result);
  },
});

export default withCors(withAuth(withScope(['mcp.read.*'])(handler)));
