import { TelegramLinkUnlinkDtoSchema } from '../../../../../src/application/dto/agent/openclaw.dto.js';
import { UnlinkTelegramUseCase } from '../../../../../src/application/use-case/agent/openclaw/telegram-link.use-case.js';
import { container } from '../../../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../../src/interface/middleware/with-rate-limit.js';
import { Response } from '../../../../../src/interface/response.js';
import { ApplicationHttpError } from '../../../../../src/core/errors.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/v1/agent/openclaw/link/unlink — dashboard-driven unlink.
 *
 * The LinkTelegramModal's linked-state branch surfaces an "Unlink"
 * CTA; this is its server side. Body is optional: with `telegramChatId`
 * it unlinks just that chat; without, it unlinks every active row for
 * the calling user (the typical sidebar-pill UX where one user has
 * one active link).
 *
 * Auth: JWT — the use-case scopes to the calling userId so a forged
 * chatId from another user cannot be unlinked through this endpoint.
 */
const useCase = new UnlinkTelegramUseCase(container.telegramLinkRepo);

const handler = createHandler({
  operationName: 'UnlinkTelegram',
  schema: TelegramLinkUnlinkDtoSchema,
  execute: async (dto, _req, authPayload) => {
    if (!authPayload?.userId) throw ApplicationHttpError.unauthorized('Unauthorized');
    const result = await useCase.execute({
      userId: authPayload.userId,
      telegramChatId: dto.telegramChatId,
    });
    return Response.ok({ unlinkedCount: result.unlinkedCount });
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
  withRateLimit({ maxRequests: 10, windowSeconds: 60 }, withAuth(router)),
);
