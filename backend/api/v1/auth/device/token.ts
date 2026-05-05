import { DeviceTokenPollDtoSchema } from '../../../../src/application/dto/auth/device-flow.dto.js';
import { PollDeviceTokenUseCase } from '../../../../src/application/use-case/auth/device-flow.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../src/interface/middleware/with-rate-limit.js';
import { Response } from '../../../../src/interface/response.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const useCase = new PollDeviceTokenUseCase(container.agentDeviceCodeRepo);

/**
 * POST /api/v1/auth/device/token — broker polls for the JWT.
 *
 * Unauthenticated (the deviceCode IS the credential); aggressively
 * rate-limited per IP per ADR-3 D4 brute-force-resistance analysis.
 *
 * Returns one of:
 *   { state: 'pending' }
 *   { state: 'authorized', jwt, scope }
 *   { state: 'denied', reason? }
 *   { state: 'expired' }
 */
const handler = createHandler({
  operationName: 'PollDeviceToken',
  schema: DeviceTokenPollDtoSchema,
  execute: async (dto) => {
    const result = await useCase.execute(dto.deviceCode);
    return Response.ok(result);
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'POST') {
    sendResponse(res, Response.badRequest('Method not allowed'));
    return;
  }
  return handler(req, res);
};

// 60 polls / minute / IP — at the broker's default 2s pollInterval that
// covers ~30 polls per ceremony per IP, with headroom for retries. The
// per-deviceCode brute-force budget shrinks naturally because each
// deviceCode lives at most 5 minutes.
export default withCors(withRateLimit({ maxRequests: 60, windowSeconds: 60 }, router));
