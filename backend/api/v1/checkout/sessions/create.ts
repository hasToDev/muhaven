import { CreateCheckoutSessionDtoSchema } from '../../../../src/application/dto/checkout/checkout.dto.js';
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
 * POST /api/v1/checkout/sessions/create — issuer mints a hosted-checkout
 * session.
 *
 * Auth: JWT-bearer with `role=issuer`. The session row is bound to
 * `authPayload.userId` so a different issuer cannot transition or
 * otherwise mutate it.
 *
 * Response includes the freshly-minted 32B fragment key — surfaced ONCE.
 * Issuers SHOULD render the URL once and forget the key (they cannot
 * recover the plaintext payload after this point without re-creating
 * the session). The URL is the buyer-facing capability.
 *
 * The hosted-page public base URL is read from env `CHECKOUT_PUBLIC_URL`;
 * defaults to `http://localhost:7780` for local dev.
 */
// Wave 4 §5 Path C — share the singleton with `commitCreateCheckout` so
// a future env-override / circuit-breaker / metrics decorator applied to
// one path also covers the other (dashboard + HavenBot agent both mint
// sessions through the same `CreateCheckoutSessionUseCase` instance).
const useCase = container.createCheckoutSession;

const handler = createHandler({
  operationName: 'CreateCheckoutSession',
  schema: CreateCheckoutSessionDtoSchema,
  execute: async (dto, _req, authPayload) => {
    if (!authPayload) {
      throw ApplicationHttpError.unauthorized('issuer auth required');
    }
    // Resolver failure should not 500 the create call — fall back to the
    // issuer-supplied label with `verified=false`. The chained resolver
    // already swallows primary-only failures; this is the floor against
    // a totally-broken resolver chain.
    const issuerLabel = await container.issuerLabelResolver
      .resolve(dto.metadata.issuerAddress as `0x${string}`)
      .catch(() => null);
    const result = await useCase.execute({
      issuerUserId: authPayload.userId,
      metadata: {
        issuerAddress: dto.metadata.issuerAddress as `0x${string}`,
        tokenAddress: dto.metadata.tokenAddress as `0x${string}`,
        tokenSymbol: dto.metadata.tokenSymbol,
        issuerLabel: issuerLabel?.label ?? dto.metadata.issuerLabel ?? null,
        description: dto.metadata.description,
        successUrl: dto.metadata.successUrl ?? null,
        cancelUrl: dto.metadata.cancelUrl ?? null,
      },
      payload: {
        amountUsd6: dto.payload.amountUsd6,
        ...(dto.payload.memo !== undefined ? { memo: dto.payload.memo } : {}),
        ...(dto.payload.referenceId !== undefined
          ? { referenceId: dto.payload.referenceId }
          : {}),
      },
      ...(dto.ttlSec ? { ttlSec: dto.ttlSec } : {}),
    });
    return Response.created({
      sessionId: result.session.sessionId,
      url: result.url,
      fragmentKey: result.fragmentKey,
      status: result.session.status,
      expiresAt: result.session.expiresAt.toISOString(),
      createdAt: result.session.createdAt.toISOString(),
      issuerLabel: result.session.metadata.issuerLabel,
      issuerLabelVerified: issuerLabel?.verified ?? false,
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

// 30 sessions / minute / issuer — generous for batch issuance via the
// API; per-IP rate limiter would be too coarse since a single issuer's
// ops box mints many sessions. JWT-keyed rate limit is Wave-5; today
// the IP throttle is the floor.
export default withCors(
  withRateLimit(
    { maxRequests: 30, windowSeconds: 60 },
    withAuth(withRole('issuer', router)),
  ),
);
