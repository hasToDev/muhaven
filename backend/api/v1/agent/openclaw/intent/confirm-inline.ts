import { z } from 'zod';
import {
  ConfirmOpenClawIntentUseCase,
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

/**
 * POST /api/v1/agent/openclaw/intent/confirm-inline
 *
 * SERVICE-secret-authenticated confirmation path used by the
 * `telegram-bot/` worker for the **inline tier only** (≤$200). The
 * worker holds the chat_id and forwards the user's "Confirm" tap; the
 * backend resolves the user via `telegram_links`.
 *
 * Refuses any intent whose tier is not `inline` — defence in depth so a
 * compromised bot worker cannot escalate a `mini_app_otp` or
 * `passkey_deeplink` intent without going through the user surface.
 */
const ConfirmInlineDtoSchema = z
  .object({
    intentId: z.string().regex(/^oci_[A-Z0-9]{26}$/),
    /** Defense-in-depth chat-binding (C-2): the bot worker forwards
     *  the callback_query's chat.id; backend asserts it matches the
     *  intent row's stored telegramChatId. */
    expectedChatId: z.string().regex(/^-?\d{1,32}$/),
    /** Defense-in-depth user-binding (M-2): the callback_query's
     *  from.id must match the binding row's telegramUserId. Defeats
     *  group-chat callback-query escalation. */
    expectedUserId: z.string().regex(/^\d{1,32}$/),
    source: z.literal('telegram_inline'),
  })
  .strict();

const intentRepo = container.openclawIntentRepo;
const linkRepo = container.telegramLinkRepo;
const auditUseCase = new AppendAuditEventUseCase(container.agentAuditRepo);
const confirmUseCase = new ConfirmOpenClawIntentUseCase(
  intentRepo,
  auditUseCase,
  container.openClawIntentEventsChannel,
);

const handler = createHandler({
  operationName: 'ConfirmOpenClawIntentInline',
  schema: ConfirmInlineDtoSchema,
  execute: async (dto) => {
    const intent = await intentRepo.findById(dto.intentId);
    if (!intent) {
      throw ApplicationHttpError.notFound('intent not found');
    }
    if (intent.tier !== OpenClawIntentTier.Inline) {
      // Tier escalation defence — service-secret path only services the
      // inline tier. mini_app_otp / passkey_deeplink intents must come
      // through the user-driven /confirm endpoint.
      throw ApplicationHttpError.forbidden(
        'intent tier requires user-driven confirmation',
      );
    }
    if (!intent.telegramChatId) {
      throw ApplicationHttpError.forbidden('intent has no Telegram binding');
    }
    if (intent.telegramChatId !== dto.expectedChatId) {
      // C-2: the bot tells us which chat the user tapped from; refuse
      // any mismatch with the intent row's bound chat. A service-secret
      // holder cannot confirm an intent from a different chat.
      throw ApplicationHttpError.forbidden('chat-id mismatch');
    }
    const link = await linkRepo.findByChatId(intent.telegramChatId);
    if (!link || !link.isActive() || link.userId !== intent.userId) {
      // Either the user unlinked Telegram between mint and confirm, or
      // a different user is now bound to that chat-id (link rotation).
      // Refuse so the previous user's pending intent cannot be
      // confirmed by a new binding.
      throw ApplicationHttpError.unauthorized('telegram chat binding mismatch');
    }
    if (link.telegramUserId !== dto.expectedUserId) {
      // M-2: the from.id of the callback_query must match the binding
      // row's user-id. In private chats chat.id == user.id; this guard
      // catches the group-chat divergence.
      throw ApplicationHttpError.unauthorized('telegram user binding mismatch');
    }
    const confirmed = await confirmUseCase.execute({
      intentId: dto.intentId,
      userId: intent.userId,
      source: 'telegram_inline',
    });
    return Response.ok({
      intent: {
        intentId: confirmed.intentId,
        kind: confirmed.kind,
        tier: confirmed.tier,
        status: confirmed.status,
        amountUsd6: confirmed.amountUsd6.toString(),
        intentHash: confirmed.intentHash,
        confirmedAt: confirmed.confirmedAt?.toISOString(),
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
