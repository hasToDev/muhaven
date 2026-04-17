import { randomUUID } from 'crypto';
import { z } from 'zod';
import { GetPortfolioUseCase } from '../../../src/application/use-case/portfolio/get-portfolio.use-case.js';
import { Portfolio } from '../../../src/domain/portfolio/model/portfolio.js';
import { container } from '../../../src/infrastructure/container.js';
import { createGetHandler, createHandler, sendResponse } from '../../../src/interface/handler-factory.js';
import { withAuth } from '../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../src/interface/response.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { AuthenticatedRequest } from '../../../src/interface/handler-factory.js';

const getUseCase = new GetPortfolioUseCase(container.portfolioRepo);

const getHandler = createGetHandler({
  operationName: 'GetPortfolio',
  execute: async (_req, authPayload) => {
    const result = await getUseCase.execute(authPayload!.userId);
    return Response.ok(result);
  },
});

const AddPositionSchema = z.object({
  token_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  token_symbol: z.string().min(1).max(20),
});

const postHandler = createHandler({
  operationName: 'AddPortfolioPosition',
  schema: AddPositionSchema,
  execute: async (dto, _req, authPayload) => {
    const existing = await container.portfolioRepo.findByUserAndToken(
      authPayload!.userId,
      dto.token_address,
    );
    if (existing) {
      return Response.ok({ status: 'already_exists' });
    }

    const portfolio = new Portfolio({
      id: randomUUID(),
      userId: authPayload!.userId,
      tokenAddress: dto.token_address,
      tokenSymbol: dto.token_symbol,
      lastSyncedAt: new Date(),
    });
    await container.portfolioRepo.save(portfolio);

    return Response.created({ status: 'created' });
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method === 'GET') {
    return getHandler(req, res);
  }
  if (req.method === 'POST') {
    return postHandler(req, res);
  }
  sendResponse(res, Response.badRequest('Method not allowed'));
};

export default withCors(withAuth(router));
