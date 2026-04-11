import { GetNavHistoryUseCase } from '../../../../src/application/use-case/nav/get-nav-history.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createGetHandler } from '../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../../src/interface/response.js';

const useCase = new GetNavHistoryUseCase(container.navHistoryRepo);

const handler = createGetHandler({
  operationName: 'GetNavHistory',
  execute: async (req) => {
    const address = req.query.address as string;
    const range = req.query.range as string | undefined;
    const result = await useCase.execute(address, range);
    return Response.ok(result);
  },
});

export default withCors(handler);
