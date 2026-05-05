import { z } from 'zod';
import { CHECKOUT_SESSION_ID_RE } from '../../../../src/domain/checkout/model/checkout-session.js';
import { LookupCheckoutSessionUseCase } from '../../../../src/application/use-case/checkout/lookup-session.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../src/interface/middleware/with-rate-limit.js';
import { Response } from '../../../../src/interface/response.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/v1/checkout/sessions/lookup — buyer page reads a session by
 * id. Public — no auth (the URL itself is the capability + the fragment
 * key is needed to actually decrypt the payload).
 *
 * Returns the encrypted payload + cleartext metadata; the page client-
 * side decrypts using the URL fragment.
 *
 * The URL endpoint is `lookup` rather than `[sessionId]` to keep route-
 * pattern parsing simple in the file-based router. Buyer-side requests
 * always carry the id in the body, not the path.
 */
const useCase = new LookupCheckoutSessionUseCase(container.checkoutSessionRepo);

const LookupSchema = z
  .object({
    sessionId: z.string().regex(CHECKOUT_SESSION_ID_RE),
  })
  .strict();

const handler = createHandler({
  operationName: 'LookupCheckoutSession',
  schema: LookupSchema,
  execute: async (dto) => {
    const result = await useCase.execute({ sessionId: dto.sessionId });
    return Response.ok({
      sessionId: result.sessionId,
      status: result.status,
      encPayload: result.encPayload,
      metadata: {
        issuerAddress: result.metadata.issuerAddress,
        tokenAddress: result.metadata.tokenAddress,
        tokenSymbol: result.metadata.tokenSymbol,
        issuerLabel: result.metadata.issuerLabel,
        description: result.metadata.description,
        successUrl: result.metadata.successUrl,
        cancelUrl: result.metadata.cancelUrl,
      },
      buyerAddress: result.buyerAddress,
      purchaseTxHash: result.purchaseTxHash,
      expiresAt: result.expiresAt.toISOString(),
      createdAt: result.createdAt.toISOString(),
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

// 60 / min / IP — buyer pages may retry on transient failures.
export default withCors(
  withRateLimit({ maxRequests: 60, windowSeconds: 60 }, router),
);
