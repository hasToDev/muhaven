import { GetIssuerTokensUseCase } from '../../../src/application/use-case/issuer/get-issuer-tokens.use-case.js';
import { container } from '../../../src/infrastructure/container.js';
import { createGetHandler } from '../../../src/interface/handler-factory.js';
import { withAuth } from '../../../src/interface/middleware/with-auth.js';
import { withRole } from '../../../src/interface/middleware/with-role.js';
import { withCors } from '../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../src/interface/response.js';

const useCase = new GetIssuerTokensUseCase(
  container.rwaTokenRepo,
  container.navHistoryRepo,
);

const handler = createGetHandler({
  operationName: 'GetIssuerTokens',
  execute: async (_req, authPayload) => {
    const result = await useCase.execute(authPayload!.walletAddress);
    return Response.ok(result);
  },
});

export default withCors(withAuth(withRole('issuer', handler)));
