import { GetLatestNavUseCase } from '../../../../../src/application/use-case/nav/get-nav-history.use-case.js';
import { container } from '../../../../../src/infrastructure/container.js';
import { createGetHandler } from '../../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../../../src/interface/response.js';

const useCase = new GetLatestNavUseCase(container.navHistoryRepo);

const handler = createGetHandler({
  operationName: 'GetLatestNav',
  execute: async (req) => {
    const address = req.query.address as string;
    const result = await useCase.execute(address);
    return Response.ok(result);
  },
});

export default withCors(handler);
