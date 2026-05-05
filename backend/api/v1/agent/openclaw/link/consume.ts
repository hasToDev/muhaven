import {
  TelegramLinkConsumeDtoSchema,
} from '../../../../../src/application/dto/agent/openclaw.dto.js';
import {
  ConsumeTelegramLinkUseCase,
} from '../../../../../src/application/use-case/agent/openclaw/telegram-link.use-case.js';
import { container } from '../../../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../../src/interface/middleware/with-rate-limit.js';
import { withServiceSecret } from '../../../../../src/interface/middleware/with-service-secret.js';
import { Response } from '../../../../../src/interface/response.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/v1/agent/openclaw/link/consume — telegram-bot worker
 * forwards a `/start <linkCode>` message from a Telegram user.
 *
 * Auth: shared service secret. Single-use — the link-code repo's
 * atomic UPDATE conditions on `consumedAt IS NULL`, so the second
 * consume of the same code returns 400 ("invalid or expired link
 * code"). Wave 5 may add a fast-path that treats a re-consume by the
 * SAME chatId as a no-op success for retry-safety after bot↔backend
 * network blips; today the bot worker handles the retry by surfacing
 * the error to the user.
 *
 * On success, returns the bound MuHaven userId so the bot can confirm
 * to the user (e.g., "Linked to wallet 0xab…cd").
 */
const useCase = new ConsumeTelegramLinkUseCase(
  container.telegramLinkCodeRepo,
  container.telegramLinkRepo,
);

const handler = createHandler({
  operationName: 'ConsumeTelegramLinkCode',
  schema: TelegramLinkConsumeDtoSchema,
  execute: async (dto) => {
    const link = await useCase.execute({
      linkCode: dto.linkCode,
      telegramChatId: dto.telegramChatId,
      telegramUserId: dto.telegramUserId,
      telegramUsername: dto.telegramUsername ?? null,
    });
    return Response.created({
      link: {
        telegramChatId: link.telegramChatId,
        telegramUserId: link.telegramUserId,
        userId: link.userId,
        linkedAt: link.linkedAt.toISOString(),
      },
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
  withRateLimit(
    { maxRequests: 30, windowSeconds: 60 },
    withServiceSecret({ envVar: 'TELEGRAM_BOT_SERVICE_SECRET', serviceName: 'telegram-bot' }, router),
  ),
);
