import {
  DenyOpenClawIntentDtoSchema,
} from '../../../../../src/application/dto/agent/openclaw.dto.js';
import {
  DenyOpenClawIntentUseCase,
} from '../../../../../src/application/use-case/agent/openclaw/confirm-intent.use-case.js';
import { AppendAuditEventUseCase } from '../../../../../src/application/use-case/agent/policy/append-audit-event.use-case.js';
import {
  TelegramInitDataInvalidError,
  TelegramInitDataVerifier,
} from '../../../../../src/application/use-case/agent/openclaw/verify-telegram-init-data.js';
import { container } from '../../../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../../src/interface/middleware/with-rate-limit.js';
import { Response } from '../../../../../src/interface/response.js';
import { ApplicationHttpError } from '../../../../../src/core/errors.js';
import { getEnv } from '../../../../../src/core/config.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const auditUseCase = new AppendAuditEventUseCase(container.agentAuditRepo);
const denyUseCase = new DenyOpenClawIntentUseCase(
  container.openclawIntentRepo,
  auditUseCase,
  container.openClawIntentEventsChannel,
);

const handler = createHandler({
  operationName: 'DenyOpenClawIntent',
  schema: DenyOpenClawIntentDtoSchema,
  execute: async (dto, _req, authPayload) => {
    let resolvedUserId: string | null = authPayload?.userId ?? null;

    if (dto.telegramInitData) {
      const env = getEnv();
      if (!env.TELEGRAM_BOT_TOKEN) {
        throw ApplicationHttpError.serviceUnavailable('TELEGRAM_BOT_TOKEN not configured');
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
      // C-3: resolve by Telegram user.id, not chat.id.
      const link = await container.telegramLinkRepo.findByTelegramUserId(verified.userId);
      if (!link || !link.isActive()) {
        throw ApplicationHttpError.unauthorized('telegram chat not linked to MuHaven');
      }
      resolvedUserId = link.userId;
    } else if (!resolvedUserId) {
      throw ApplicationHttpError.unauthorized('Unauthorized');
    }

    const intent = await denyUseCase.execute({
      intentId: dto.intentId,
      userId: resolvedUserId,
      ...(dto.reason ? { reason: dto.reason } : {}),
    });
    return Response.ok({
      intent: {
        intentId: intent.intentId,
        status: intent.status,
        deniedAt: intent.deniedAt?.toISOString(),
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

const optionalAuth = (h: typeof router): typeof router => async (req, res) => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return withAuth(h)(req, res);
  }
  return h(req, res);
};

export default withCors(
  withRateLimit({ maxRequests: 30, windowSeconds: 60 }, optionalAuth(router)),
);
