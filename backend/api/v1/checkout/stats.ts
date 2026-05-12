import {
  GetCheckoutStatsRequestSchema,
} from '../../../src/application/dto/checkout/checkout.dto.js';
import { GetIssuerStatsUseCase } from '../../../src/application/use-case/checkout/get-issuer-stats.use-case.js';
import type { CheckoutStatsRange } from '../../../src/application/dto/checkout/checkout.dto.js';
import { container } from '../../../src/infrastructure/container.js';
import {
  createGetHandler,
  sendResponse,
} from '../../../src/interface/handler-factory.js';
import { withAuth } from '../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../src/interface/middleware/with-rate-limit.js';
import { withRole } from '../../../src/interface/middleware/with-role.js';
import { Response } from '../../../src/interface/response.js';
import { ApplicationHttpError } from '../../../src/core/errors.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/v1/checkout/stats?range=7d|30d|all — aggregate counts for the
 * issuer dashboard stats card. Count-only — no amount aggregation (the
 * privacy boundary makes amounts structurally invisible to the backend).
 * See `ISSUER_CHECKOUT_DASHBOARD_PLAN.md` §1.A invariant 3.
 */
const useCase = new GetIssuerStatsUseCase(
  container.checkoutSessionRepo,
  container.userRepo,
);

const getHandler = createGetHandler({
  operationName: 'GetIssuerCheckoutStats',
  execute: async (req, authPayload) => {
    if (!authPayload) {
      throw ApplicationHttpError.unauthorized('issuer auth required');
    }
    const query = req.query as Record<string, string | string[] | undefined>;
    const dto = GetCheckoutStatsRequestSchema.parse({ range: query.range });
    const result = await useCase.execute({
      issuerUserId: authPayload.userId,
      range: dto.range as CheckoutStatsRange | undefined,
    });
    return Response.ok(result);
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'GET') {
    sendResponse(res, Response.badRequest('Method not allowed'));
    return;
  }
  return getHandler(req, res);
};

export default withCors(
  withRateLimit(
    { maxRequests: 30, windowSeconds: 60 },
    withAuth(withRole('issuer', router)),
  ),
);
