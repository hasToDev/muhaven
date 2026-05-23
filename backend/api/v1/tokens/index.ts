import type { VercelRequest, VercelResponse } from '@vercel/node';
import { CreateTokenDtoSchema } from '../../../src/application/dto/token/token-response.dto.js';
import { GetTokensUseCase } from '../../../src/application/use-case/token/get-tokens.use-case.js';
import { CreateTokenUseCase } from '../../../src/application/use-case/token/create-token.use-case.js';
import { container } from '../../../src/infrastructure/container.js';
import { createHandler, createGetHandler, sendResponse } from '../../../src/interface/handler-factory.js';
import { withAuth } from '../../../src/interface/middleware/with-auth.js';
import { withRole } from '../../../src/interface/middleware/with-role.js';
import { withCors } from '../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../src/interface/response.js';

const getTokensUseCase = new GetTokensUseCase(
  container.rwaTokenRepo,
  container.navHistoryRepo,
  container.userRepo,
  container.oracleRepo,
);
const createTokenUseCase = new CreateTokenUseCase(container.rwaTokenRepo);

const getHandler = createGetHandler({
  operationName: 'GetTokens',
  execute: async () => {
    const result = await getTokensUseCase.execute();
    return Response.ok(result);
  },
});

const postHandler = createHandler({
  operationName: 'CreateToken',
  schema: CreateTokenDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const result = await createTokenUseCase.execute(dto, authPayload!.walletAddress);
    return Response.created(result);
  },
});

const protectedPost = withAuth(withRole('issuer', postHandler));

const handler = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method === 'GET') {
    return getHandler(req, res);
  }
  if (req.method === 'POST') {
    return protectedPost(req, res);
  }
  sendResponse(res, Response.badRequest('Method not allowed'));
};

export default withCors(handler);
