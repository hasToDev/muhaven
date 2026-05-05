import {
  IssueTelegramLinkCodeUseCase,
} from '../../../../../src/application/use-case/agent/openclaw/telegram-link.use-case.js';
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
import { getEnv } from '../../../../../src/core/config.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/v1/agent/openclaw/link/issue — dashboard mints a one-time
 * Telegram link code. The user is JWT-authenticated. Response includes
 * the code + a `t.me/<bot>?start=<code>` URL the dashboard renders as
 * a QR code / clickable link.
 */
const useCase = new IssueTelegramLinkCodeUseCase(container.telegramLinkCodeRepo);

const handler = createGetHandler({
  operationName: 'IssueTelegramLinkCode',
  execute: async (_req, authPayload) => {
    if (!authPayload?.userId) throw ApplicationHttpError.unauthorized('Unauthorized');
    const result = await useCase.execute(authPayload.userId);
    const env = getEnv();
    return {
      linkCode: result.linkCode,
      expiresInSec: result.expiresInSec,
      botStartUrl: env.TELEGRAM_BOT_USERNAME
        ? result.botStartUrl(env.TELEGRAM_BOT_USERNAME)
        : null,
    };
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  // POST only — minting a code is a state-mutating action; GET-with-side
  // effects would be CSRF-vulnerable if cookie auth ever lands. (L-6)
  if (req.method !== 'POST') {
    sendResponse(res, Response.badRequest('Method not allowed'));
    return;
  }
  return handler(req, res);
};

export default withCors(
  withRateLimit({ maxRequests: 5, windowSeconds: 60 }, withAuth(router)),
);
