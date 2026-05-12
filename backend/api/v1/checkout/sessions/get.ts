import {
  GetCheckoutSessionRequestSchema,
} from '../../../../src/application/dto/checkout/checkout.dto.js';
import { GetSessionForIssuerUseCase } from '../../../../src/application/use-case/checkout/get-session-for-issuer.use-case.js';
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
 * GET /api/v1/checkout/sessions/get?id=cs_… — issuer-side session detail.
 * Returns 404 when the session is missing OR owned by a different issuer
 * (defeats sessionId enumeration). encPayload NEVER surfaced.
 */
const useCase = new GetSessionForIssuerUseCase(
  container.checkoutSessionRepo,
  container.userRepo,
);

const getHandler = createGetHandler({
  operationName: 'GetCheckoutSessionForIssuer',
  execute: async (req, authPayload) => {
    if (!authPayload) {
      throw ApplicationHttpError.unauthorized('issuer auth required');
    }
    const query = req.query as Record<string, string | string[] | undefined>;
    const dto = GetCheckoutSessionRequestSchema.parse({ id: query.id });
    const result = await useCase.execute({
      issuerUserId: authPayload.userId,
      sessionId: dto.id,
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
