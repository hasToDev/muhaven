import { GetPortfolioUseCase } from '../../../src/application/use-case/portfolio/get-portfolio.use-case.js';
import { container } from '../../../src/infrastructure/container.js';
import { createGetHandler } from '../../../src/interface/handler-factory.js';
import { withAuth } from '../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../src/interface/response.js';

const useCase = new GetPortfolioUseCase(container.portfolioRepo);

const handler = createGetHandler({
  operationName: 'GetPortfolio',
  execute: async (_req, authPayload) => {
    const result = await useCase.execute(authPayload!.userId);
    return Response.ok(result);
  },
});

export default withCors(withAuth(handler));
