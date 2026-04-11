import { GetActivityUseCase } from '../../../src/application/use-case/activity/get-activity.use-case.js';
import { container } from '../../../src/infrastructure/container.js';
import { createGetHandler } from '../../../src/interface/handler-factory.js';
import { withAuth } from '../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../src/interface/response.js';

const useCase = new GetActivityUseCase(container.yieldRecordRepo, container.escrowRepo);

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

export default withCors(withAuth(handler));
