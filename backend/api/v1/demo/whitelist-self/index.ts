import { z } from 'zod';
import { WhitelistSelfUseCase } from '../../../../src/application/use-case/demo/whitelist-self.use-case.js';
import { createHandler } from '../../../../src/interface/handler-factory.js';
import type { AuthenticatedRequest } from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../src/interface/middleware/with-rate-limit.js';
import { Response } from '../../../../src/interface/response.js';
import { ApplicationHttpError } from '../../../../src/core/errors.js';

const EmptyBodySchema = z
  .object({})
  .passthrough()
  .transform(() => ({}));

const useCase = new WhitelistSelfUseCase();

const handler = createHandler({
  operationName: 'WhitelistSelf',
  schema: EmptyBodySchema,
  execute: async (_dto, _req, authPayload) => {
    if (!authPayload?.walletAddress) {
      throw ApplicationHttpError.unauthorized('Missing wallet address in token');
    }
    const result = await useCase.execute(authPayload.walletAddress);
    return Response.ok(result);
  },
});

// Per-user rate limit (1 request per hour) keyed by the JWT subject so a user
// can't bypass it by rotating IPs. Falls back to IP if userId isn't set (which
// shouldn't happen since withAuth runs first, but defensive).
export default withCors(
  withAuth(
    withRateLimit(
      {
        maxRequests: 1,
        windowSeconds: 3600,
        keyFn: (req) => {
          const authPayload = (req as AuthenticatedRequest).authPayload;
          return authPayload?.userId ?? 'anon';
        },
      },
      handler,
    ),
  ),
);
