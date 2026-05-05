import { z } from 'zod';
import {
  LookupOpenClawIntentUseCase,
} from '../../../../../src/application/use-case/agent/openclaw/confirm-intent.use-case.js';
import {
  TelegramInitDataInvalidError,
  TelegramInitDataVerifier,
} from '../../../../../src/application/use-case/agent/openclaw/verify-telegram-init-data.js';
import { container } from '../../../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../../src/interface/middleware/with-rate-limit.js';
import { Response } from '../../../../../src/interface/response.js';
import { ApplicationHttpError } from '../../../../../src/core/errors.js';
import { getEnv } from '../../../../../src/core/config.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/v1/agent/openclaw/intent/lookup-miniapp
 *
 * Telegram Mini App calls this with the verified `tgWebAppData` initData
 * and the intentId. Backend HMAC-verifies initData against the bot
 * token, resolves the chat-id to a MuHaven user via `telegram_links`,
 * and returns the public preview if the intent belongs to that user.
 *
 * Same collapsed-oracle response shape as /lookup — any failure mode
 * is 404 to defeat enumeration.
 */
const LookupMiniAppDtoSchema = z
  .object({
    intentId: z.string().regex(/^oci_[A-Z0-9]{26}$/),
    telegramInitData: z.string().min(1).max(8 * 1024),
  })
  .strict();

const useCase = new LookupOpenClawIntentUseCase(container.openclawIntentRepo);

const handler = createHandler({
  operationName: 'LookupOpenClawIntentMiniApp',
  schema: LookupMiniAppDtoSchema,
  execute: async (dto) => {
    const env = getEnv();
    if (!env.TELEGRAM_BOT_TOKEN) {
      throw ApplicationHttpError.serviceUnavailable(
        'mini-app verification disabled — TELEGRAM_BOT_TOKEN not configured',
      );
    }
    const verifier = new TelegramInitDataVerifier({ botToken: env.TELEGRAM_BOT_TOKEN });
    let verified;
    try {
      verified = verifier.verify(dto.telegramInitData);
    } catch (err) {
      if (err instanceof TelegramInitDataInvalidError) {
        throw ApplicationHttpError.unauthorized(`mini-app initData ${err.code}`);
      }
      throw err;
    }
    // C-3: Mini App initData carries `user.id` (not `chat.id`). Resolve
    // via the user-id binding so a Mini App opened from a context where
    // chat.id ≠ user.id cannot inspect an intent belonging to a
    // different chat binding.
    const link = await container.telegramLinkRepo.findByTelegramUserId(verified.userId);
    if (!link || !link.isActive()) {
      throw ApplicationHttpError.notFound('intent not found');
    }
    return useCase.execute({
      intentId: dto.intentId,
      expectedUserId: link.userId,
      expectedChatId: link.telegramChatId,
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

export default withCors(
  withRateLimit({ maxRequests: 60, windowSeconds: 60 }, router),
);
