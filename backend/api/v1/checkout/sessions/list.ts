import {
  ListCheckoutSessionsRequestSchema,
} from '../../../../src/application/dto/checkout/checkout.dto.js';
import { ListCheckoutSessionsUseCase } from '../../../../src/application/use-case/checkout/list-sessions.use-case.js';
import type { CheckoutSessionStatus } from '../../../../src/domain/checkout/model/checkout-session.js';
import { container } from '../../../../src/infrastructure/container.js';
import {
  createGetHandler,
  sendResponse,
} from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../src/interface/middleware/with-rate-limit.js';
import { withRole } from '../../../../src/interface/middleware/with-role.js';
import { Response } from '../../../../src/interface/response.js';
import { ApplicationHttpError } from '../../../../src/core/errors.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/v1/checkout/sessions/list?status=&cursor=&limit= — issuer-side
 * paginated listing of hosted-checkout sessions. Scoped to the caller;
 * encPayload NEVER surfaced (privacy invariant — see plan §1.A).
 */
const useCase = new ListCheckoutSessionsUseCase(
  container.checkoutSessionRepo,
  container.userRepo,
);

const getHandler = createGetHandler({
  operationName: 'ListCheckoutSessions',
  execute: async (req, authPayload) => {
    if (!authPayload) {
      throw ApplicationHttpError.unauthorized('issuer auth required');
    }
    const query = req.query as Record<string, string | string[] | undefined>;
    const dto = ListCheckoutSessionsRequestSchema.parse({
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    const result = await useCase.execute({
      issuerUserId: authPayload.userId,
      status: dto.status as CheckoutSessionStatus | undefined,
      cursor: dto.cursor,
      limit: dto.limit,
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
    { maxRequests: 60, windowSeconds: 60 },
    withAuth(withRole('issuer', router)),
  ),
);
