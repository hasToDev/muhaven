import { z } from 'zod';
import {
  DenyOpenClawIntentUseCase,
} from '../../../../../src/application/use-case/agent/openclaw/confirm-intent.use-case.js';
import { AppendAuditEventUseCase } from '../../../../../src/application/use-case/agent/policy/append-audit-event.use-case.js';
import { container } from '../../../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../../src/interface/middleware/with-rate-limit.js';
import { withServiceSecret } from '../../../../../src/interface/middleware/with-service-secret.js';
import { Response } from '../../../../../src/interface/response.js';
import { ApplicationHttpError } from '../../../../../src/core/errors.js';
import {
  OpenClawIntentTier,
} from '../../../../../src/domain/agent/model/openclaw-intent.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const DenyInlineDtoSchema = z
  .object({
    intentId: z.string().regex(/^oci_[A-Z0-9]{26}$/),
    expectedChatId: z.string().regex(/^-?\d{1,32}$/),
    expectedUserId: z.string().regex(/^\d{1,32}$/),
    reason: z.string().max(200).optional(),
  })
  .strict();

const intentRepo = container.openclawIntentRepo;
const linkRepo = container.telegramLinkRepo;
const auditUseCase = new AppendAuditEventUseCase(container.agentAuditRepo);
const denyUseCase = new DenyOpenClawIntentUseCase(
  intentRepo,
  auditUseCase,
  container.openClawIntentEventsChannel,
);

const handler = createHandler({
  operationName: 'DenyOpenClawIntentInline',
  schema: DenyInlineDtoSchema,
  execute: async (dto) => {
    const intent = await intentRepo.findById(dto.intentId);
    if (!intent) throw ApplicationHttpError.notFound('intent not found');
    if (intent.tier !== OpenClawIntentTier.Inline) {
      throw ApplicationHttpError.forbidden('intent tier requires user-driven action');
    }
    if (!intent.telegramChatId) {
      throw ApplicationHttpError.forbidden('intent has no Telegram binding');
    }
    if (intent.telegramChatId !== dto.expectedChatId) {
      throw ApplicationHttpError.forbidden('chat-id mismatch');
    }
    const link = await linkRepo.findByChatId(intent.telegramChatId);
    if (!link || !link.isActive() || link.userId !== intent.userId) {
      throw ApplicationHttpError.unauthorized('telegram chat binding mismatch');
    }
    if (link.telegramUserId !== dto.expectedUserId) {
      throw ApplicationHttpError.unauthorized('telegram user binding mismatch');
    }
    const denied = await denyUseCase.execute({
      intentId: dto.intentId,
      userId: intent.userId,
      ...(dto.reason ? { reason: dto.reason } : {}),
    });
    return Response.ok({
      intent: {
        intentId: denied.intentId,
        status: denied.status,
        deniedAt: denied.deniedAt?.toISOString(),
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
    { maxRequests: 60, windowSeconds: 60 },
    withServiceSecret({ envVar: 'TELEGRAM_BOT_SERVICE_SECRET', serviceName: 'telegram-bot' }, router),
  ),
);
