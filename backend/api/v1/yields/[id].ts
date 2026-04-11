import { GetYieldByIdUseCase } from '../../../src/application/use-case/yield/get-yields.use-case.js';
import { container } from '../../../src/infrastructure/container.js';
import { createGetHandler } from '../../../src/interface/handler-factory.js';
import { withAuth } from '../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../src/interface/response.js';

const useCase = new GetYieldByIdUseCase(container.yieldRecordRepo);

const handler = createGetHandler({
  operationName: 'GetYieldById',
  execute: async (req, authPayload) => {
    const id = req.query.id as string;
    const result = await useCase.execute(id, authPayload!.userId);
    return Response.ok(result);
  },
});

export default withCors(withAuth(handler));
