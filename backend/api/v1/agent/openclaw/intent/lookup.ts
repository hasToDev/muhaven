import {
  LookupOpenClawIntentUseCase,
} from '../../../../../src/application/use-case/agent/openclaw/confirm-intent.use-case.js';
import { container } from '../../../../../src/infrastructure/container.js';
import {
  createGetHandler,
  sendResponse,
} from '../../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../../src/interface/middleware/with-rate-limit.js';
import { Response } from '../../../../../src/interface/response.js';
import { ApplicationHttpError } from '../../../../../src/core/errors.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/v1/agent/openclaw/intent/lookup?intentId=oci_xxx
 *
 * Used by the dashboard `/agent/confirm` page (authenticated SIWE/JWT)
 * to fetch a public summary of a pending intent before the user taps
 * Authorize. Mirrors the device-code `/auth/device/lookup` shape:
 * collapses every "not authorisable now" case to 404 to defeat
 * intent-id enumeration.
 *
 * The Mini App uses a separate route (`/intent/lookup-miniapp`) that
 * verifies Telegram initData instead of dashboard auth.
 */
const useCase = new LookupOpenClawIntentUseCase(container.openclawIntentRepo);
const INTENT_ID_RE = /^oci_[A-Z0-9]{26}$/;

const handler = createGetHandler({
  operationName: 'LookupOpenClawIntent',
  execute: async (req, authPayload) => {
    if (!authPayload?.userId) {
      throw ApplicationHttpError.unauthorized('Unauthorized');
    }
    const intentId = typeof req.query.intentId === 'string' ? req.query.intentId : '';
    if (!INTENT_ID_RE.test(intentId)) {
      throw ApplicationHttpError.badRequest('intentId malformed');
    }
    return useCase.execute({
      intentId,
      expectedUserId: authPayload.userId,
    });
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'GET') {
    sendResponse(res, Response.badRequest('Method not allowed'));
    return;
  }
  return handler(req, res);
};

export default withCors(
  withRateLimit({ maxRequests: 60, windowSeconds: 60 }, withAuth(router)),
);
