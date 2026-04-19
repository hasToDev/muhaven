import { GetYieldsUseCase } from '../../../src/application/use-case/yield/get-yields.use-case.js';
import { container } from '../../../src/infrastructure/container.js';
import { createGetHandler } from '../../../src/interface/handler-factory.js';
import { withAuth } from '../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../src/interface/response.js';

const useCase = new GetYieldsUseCase(container.yieldRecordRepo, container.escrowRepo);

const handler = createGetHandler({
  operationName: 'GetYields',
  execute: async (req, authPayload) => {
    const rawLimit = req.query.limit ? Number(req.query.limit) : undefined;
    const rawOffset = req.query.offset ? Number(req.query.offset) : undefined;
    if ((rawLimit !== undefined && (!Number.isInteger(rawLimit) || rawLimit < 1)) ||
        (rawOffset !== undefined && (!Number.isInteger(rawOffset) || rawOffset < 0))) {
      return Response.badRequest('Invalid pagination', 'limit must be a positive integer, offset must be a non-negative integer');
    }
    const status = req.query.status as string | undefined;
    const result = await useCase.execute(authPayload!.userId, { limit: rawLimit, offset: rawOffset, status });
    return Response.ok(result);
  },
});

export default withCors(withAuth(handler));
