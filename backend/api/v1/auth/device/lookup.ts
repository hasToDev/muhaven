import { z } from 'zod';
import { container } from '../../../../src/infrastructure/container.js';
import {
  createGetHandler,
  sendResponse,
} from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../src/interface/middleware/with-rate-limit.js';
import { Response } from '../../../../src/interface/response.js';
import { DeviceCodeStatus } from '../../../../src/domain/auth/model/agent-device-code.js';
import { USER_CODE_REGEX } from '../../../../src/application/use-case/auth/device-flow.use-case.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Wave 4 P3 ADR-3 §"Code Review #2": derive the strict regex from the
// alphabet so lookup, DTO, use-case, and frontend agree byte-for-byte.
const userCodeSchema = z
  .string()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(USER_CODE_REGEX));

/**
 * GET /api/v1/auth/device/lookup?code=ABCD-1234
 *
 * Read-only metadata for a *pending* device-code row, surfaced to the
 * dashboard `/link` page so the user can verify the requesterMetadata
 * (process / hostname / OS) BEFORE tapping passkey-Authorize. Per
 * ADR-3 D4 this is the load-bearing phishing mitigation — without it
 * the user only sees the metadata after they've already approved.
 *
 * Returns 404 with a generic body for non-pending / unknown codes (no
 * existence disclosure beyond "this code is not currently waiting").
 */
const handler = createGetHandler({
  operationName: 'LookupDeviceCode',
  execute: async (req) => {
    const raw = (req.query as Record<string, string | string[] | undefined>).code;
    const codeStr = Array.isArray(raw) ? raw[0] : raw;
    const parsed = userCodeSchema.safeParse(codeStr);
    if (!parsed.success) {
      return Response.badRequest('code is required and must match XXXX-XXXX');
    }
    const userCode = parsed.data.toUpperCase();
    const row = await container.agentDeviceCodeRepo.findByUserCode(userCode);
    if (!row || row.status !== DeviceCodeStatus.Pending || row.isExpired()) {
      return Response.notFound('code not found or not pending');
    }
    return Response.ok({
      userCode: row.userCode,
      requesterMetadata: row.requesterMetadata,
      expiresAt: row.expiresAt.toISOString(),
    });
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method === 'GET') return handler(req, res);
  sendResponse(res, Response.badRequest('Method not allowed'));
};

// 60 lookups / minute / IP — generous for normal use, defensive against
// userCode brute-force enumeration.
export default withCors(withRateLimit({ maxRequests: 60, windowSeconds: 60 }, withAuth(router)));
