import { DeviceAuthorizeDtoSchema } from '../../../../src/application/dto/auth/device-flow.dto.js';
import { AuthorizeDeviceCodeUseCase } from '../../../../src/application/use-case/auth/device-flow.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../src/interface/middleware/with-rate-limit.js';
import { Response } from '../../../../src/interface/response.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const useCase = new AuthorizeDeviceCodeUseCase(
  container.agentDeviceCodeRepo,
  container.userRepo,
  container.jwtService,
);

/**
 * POST /api/v1/auth/device/authorize — dashboard /link page authorizes
 * (or denies) a device-code on behalf of the authenticated user.
 *
 * Authenticated via the dashboard's existing SIWE/JWT (NOT the
 * device-flow JWT being minted — chicken-and-egg). The minted device-flow
 * JWT is then stored on the device-code row and exposed once via the
 * /token poll.
 */
const handler = createHandler({
  operationName: 'AuthorizeDeviceCode',
  schema: DeviceAuthorizeDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const userId = authPayload!.userId;
    const result = await useCase.execute({
      userCode: dto.userCode.toUpperCase(),
      userId,
      ...(dto.deny ? { deny: true } : {}),
      ...(dto.denyReason ? { denyReason: dto.denyReason } : {}),
    });
    return Response.ok({
      status: result.deviceCode.status,
      requesterMetadata: result.deviceCode.requesterMetadata,
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

// 5 authorize attempts per minute per IP — defends against userCode
// brute-force per ADR-3 D4. Anti-pattern would be doing this per-user
// because an attacker can rotate user accounts; per-IP throttling ties
// the budget to network-layer ACLs the attacker must also rotate.
export default withCors(
  withRateLimit({ maxRequests: 5, windowSeconds: 60 }, withAuth(router)),
);
