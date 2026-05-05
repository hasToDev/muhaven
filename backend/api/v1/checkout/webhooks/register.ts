import { RegisterWebhookEndpointDtoSchema } from '../../../../src/application/dto/checkout/checkout.dto.js';
import { RegisterWebhookEndpointUseCase } from '../../../../src/application/use-case/checkout/register-webhook.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../src/interface/middleware/with-rate-limit.js';
import { withRole } from '../../../../src/interface/middleware/with-role.js';
import { Response } from '../../../../src/interface/response.js';
import { ApplicationHttpError } from '../../../../src/core/errors.js';
import type { WebhookEventType } from '../../../../src/domain/checkout/model/webhook-endpoint.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/v1/checkout/webhooks/register — issuer registers a webhook
 * endpoint. The signing secret is returned ONCE in the response; the
 * issuer is responsible for storing it. Subsequent reads (Wave 5
 * dashboard) return only a hint.
 */
const useCase = new RegisterWebhookEndpointUseCase(
  container.webhookEndpointRepo,
  container.userRepo,
);

const handler = createHandler({
  operationName: 'RegisterWebhookEndpoint',
  schema: RegisterWebhookEndpointDtoSchema,
  execute: async (dto, _req, authPayload) => {
    if (!authPayload) {
      throw ApplicationHttpError.unauthorized('issuer auth required');
    }
    const result = await useCase.execute({
      issuerUserId: authPayload.userId,
      url: dto.url,
      ...(dto.enabledEvents
        ? { enabledEvents: dto.enabledEvents as readonly WebhookEventType[] }
        : {}),
    });
    return Response.created({
      endpointId: result.endpoint.endpointId,
      url: result.endpoint.url,
      enabledEvents: result.endpoint.enabledEvents,
      signingSecret: result.signingSecret,
      createdAt: result.endpoint.createdAt.toISOString(),
    });
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'POST') {
    sendResponse(res, Response.badRequest('Method not allowed'));
    return;
  }
  return handler(req, res);
};

// 12 / min — issuer creates a small handful of endpoints per session.
export default withCors(
  withRateLimit(
    { maxRequests: 12, windowSeconds: 60 },
    withAuth(withRole('issuer', router)),
  ),
);
