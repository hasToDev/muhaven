import { GetActivityUseCase } from '../../../src/application/use-case/activity/get-activity.use-case.js';
import { container } from '../../../src/infrastructure/container.js';
import { createGetHandler } from '../../../src/interface/handler-factory.js';
import { withAuth } from '../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../src/interface/response.js';

const useCase = new GetActivityUseCase(container.taxEventRepo, container.userRepo);

const handler = createGetHandler({
  operationName: 'GetActivity',
  execute: async (req, authPayload) => {
    const rawLimit = req.query.limit ? Number(req.query.limit) : undefined;
    const rawOffset = req.query.offset ? Number(req.query.offset) : undefined;
    if ((rawLimit !== undefined && (!Number.isInteger(rawLimit) || rawLimit < 1)) ||
        (rawOffset !== undefined && (!Number.isInteger(rawOffset) || rawOffset < 0))) {
      return Response.badRequest('Invalid pagination', 'limit must be a positive integer, offset must be a non-negative integer');
    }
    const result = await useCase.execute(authPayload!.userId, { limit: rawLimit, offset: rawOffset });
    return Response.ok(result);
  },
});

// Wave 4 P3 ADR-3 D2: device-flow JWTs must carry `mcp.read.*` to
// read the activity feed. Legacy unscoped (SIWE) tokens have no
// `scope` claim and fall through with full access — preserves the
// existing dashboard Activity page contract.
export default withCors(withAuth(withScope(['mcp.read.*'])(handler)));
