import { ListWebhooksUseCase } from '../../../../src/application/use-case/checkout/list-webhooks.use-case.js';
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
 * GET /api/v1/checkout/webhooks/list — issuer-side webhook registry view.
 * Returns active + disabled rows. signingSecret HINT only — never the
 * full value. See `ISSUER_CHECKOUT_DASHBOARD_PLAN.md` §1.A invariant 2.
 */
const useCase = new ListWebhooksUseCase(
  container.webhookEndpointRepo,
  container.userRepo,
);

const getHandler = createGetHandler({
  operationName: 'ListWebhookEndpoints',
  execute: async (_req, authPayload) => {
    if (!authPayload) {
      throw ApplicationHttpError.unauthorized('issuer auth required');
    }
    const result = await useCase.execute({ issuerUserId: authPayload.userId });
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
