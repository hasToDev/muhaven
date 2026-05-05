import { DisableWebhookEndpointDtoSchema } from '../../../../src/application/dto/checkout/checkout.dto.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../src/interface/middleware/with-rate-limit.js';
import { withRole } from '../../../../src/interface/middleware/with-role.js';
import { Response } from '../../../../src/interface/response.js';
import { ApplicationHttpError } from '../../../../src/core/errors.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/v1/checkout/webhooks/disable — issuer revokes a webhook
 * endpoint. The dispatcher stops sending events to a disabled endpoint
 * immediately (atomic conditional UPDATE; concurrent dispatches see
 * the new `disabledAt` and skip).
 *
 * Disabling is reversible only by re-registering — there's no "re-
 * enable" path because the signing secret would have to rotate, and
 * pretending it stayed live across a disable cycle would invite
 * confused-deputy bugs.
 */
const handler = createHandler({
  operationName: 'DisableWebhookEndpoint',
  schema: DisableWebhookEndpointDtoSchema,
  execute: async (dto, _req, authPayload) => {
    if (!authPayload) {
      throw ApplicationHttpError.unauthorized('issuer auth required');
    }
    // Phase 9.A · F2 onboarding gate (port-time fix). Symmetric with
    // create-session + register-webhook: a JWT with `role='issuer'`
    // but `issuerStatus !== 'approved'` cannot reach the persistence
    // layer. Without the gate a `pending`/`suspended` issuer could
    // disable a previously-approved peer's endpoint (the row's
    // `issuerUserId` mismatch would already 404, but defense-in-
    // depth keeps the lifecycle gate symmetric across all three
    // P5 issuer-driven endpoints).
    const issuer = await container.userRepo.findById(authPayload.userId);
    if (!issuer || issuer.role !== 'issuer' || issuer.issuerStatus !== 'approved') {
      throw ApplicationHttpError.forbidden(
        'Issuer onboarding required before webhook disable',
        { code: 'NOT_APPROVED_ISSUER' },
      );
    }
    const updated = await container.webhookEndpointRepo.disable({
      endpointId: dto.endpointId,
      issuerUserId: authPayload.userId,
      now: new Date(),
    });
    if (!updated) {
      // Collapses every "not disable-able now" case to 404 to defeat
      // endpoint-id enumeration.
      throw ApplicationHttpError.notFound('webhook endpoint not found');
    }
    return Response.ok({
      endpointId: updated.endpointId,
      disabledAt: updated.disabledAt?.toISOString(),
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

export default withCors(
  withRateLimit(
    { maxRequests: 12, windowSeconds: 60 },
    withAuth(withRole('issuer', router)),
  ),
);
