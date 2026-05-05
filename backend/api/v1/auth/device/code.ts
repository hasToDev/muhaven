import { DeviceCodeRequestDtoSchema } from '../../../../src/application/dto/auth/device-flow.dto.js';
import { IssueDeviceCodeUseCase } from '../../../../src/application/use-case/auth/device-flow.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../src/interface/middleware/with-rate-limit.js';
import { Response } from '../../../../src/interface/response.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const useCase = new IssueDeviceCodeUseCase(container.agentDeviceCodeRepo);

/**
 * POST /api/v1/auth/device/code — broker requests a device-code pair.
 *
 * Unauthenticated; rate-limited per source IP. Per ADR-3 D1 the broker
 * (running on the user's local machine) is the only legitimate caller.
 */
const handler = createHandler({
  operationName: 'IssueDeviceCode',
  schema: DeviceCodeRequestDtoSchema,
  execute: async (dto) => {
    const result = await useCase.execute({
      processName: dto.requesterMetadata.processName,
      hostname: dto.requesterMetadata.hostname ?? '',
      os: dto.requesterMetadata.os ?? '',
    });
    return Response.ok({
      deviceCode: result.deviceCode,
      userCode: result.userCode,
      expiresInSec: result.expiresInSec,
      pollIntervalSec: result.pollIntervalSec,
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

// 30 device-code issues / minute / IP — generous to avoid blocking legit
// install flows but defensive against a userCode brute-force precursor.
export default withCors(withRateLimit({ maxRequests: 30, windowSeconds: 60 }, router));
