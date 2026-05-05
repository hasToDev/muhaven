import {
  TransitionCheckoutSessionDtoSchema,
} from '../../../../src/application/dto/checkout/checkout.dto.js';
import {
  CheckoutSessionStatus,
} from '../../../../src/domain/checkout/model/checkout-session.js';
import { TransitionCheckoutSessionUseCase } from '../../../../src/application/use-case/checkout/transition-session.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../src/interface/middleware/with-rate-limit.js';
import { Response } from '../../../../src/interface/response.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/v1/checkout/sessions/transition — buyer page reports a state
 * transition (funded → wrapped → purchased).
 *
 * Public — no auth. The URL + fragment key are the capability; the
 * status field flips forward only and is gated by `isForwardTransition`.
 * `settled` is REJECTED here — that status is reserved for backend-side
 * verification (chain indexer; Wave 5).
 *
 * Concurrent transitions resolve via conditional UPDATE in the repo;
 * the loser sees a 409 Conflict and re-fetches.
 */
const useCase = new TransitionCheckoutSessionUseCase(
  container.checkoutSessionRepo,
  container.checkoutSseChannel,
  container.webhookDispatcher,
);

const handler = createHandler({
  operationName: 'TransitionCheckoutSession',
  schema: TransitionCheckoutSessionDtoSchema,
  execute: async (dto) => {
    const result = await useCase.execute({
      sessionId: dto.sessionId,
      newStatus: dto.newStatus as CheckoutSessionStatus,
      ...(dto.buyerAddress
        ? { buyerAddress: dto.buyerAddress as `0x${string}` }
        : {}),
      ...(dto.purchaseTxHash
        ? { purchaseTxHash: dto.purchaseTxHash }
        : {}),
    });
    return Response.ok({
      sessionId: result.session.sessionId,
      status: result.session.status,
      buyerAddress: result.session.buyerAddress,
      purchaseTxHash: result.session.purchaseTxHash,
      updatedAt: result.session.updatedAt.toISOString(),
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

// 30 / min / IP — buyer-driven transitions arrive in clumps as the
// flow progresses; the cap survives a normal flow with reload buffer.
export default withCors(
  withRateLimit({ maxRequests: 30, windowSeconds: 60 }, router),
);
