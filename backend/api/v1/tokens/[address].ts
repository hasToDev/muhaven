import { GetTokenByAddressUseCase } from '../../../src/application/use-case/token/get-tokens.use-case.js';
import { container } from '../../../src/infrastructure/container.js';
import { createGetHandler } from '../../../src/interface/handler-factory.js';
import { withCors } from '../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../src/interface/response.js';

const useCase = new GetTokenByAddressUseCase(
  container.rwaTokenRepo,
  container.navHistoryRepo,
  container.userRepo,
);

const handler = createGetHandler({
  operationName: 'GetTokenByAddress',
  execute: async (req) => {
    const address = req.query.address as string;
    const result = await useCase.execute(address);
    if (!result) {
      return Response.notFound('Token not found', `No token registered at ${address}`);
    }
    return Response.ok(result);
  },
});

export default withCors(handler);
