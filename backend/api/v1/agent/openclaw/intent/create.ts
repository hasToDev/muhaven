import {
  CreateOpenClawIntentDtoSchema,
} from '../../../../../src/application/dto/agent/openclaw.dto.js';
import {
  CreateOpenClawIntentUseCase,
} from '../../../../../src/application/use-case/agent/openclaw/create-intent.use-case.js';
import { OpenClawIntentKind } from '../../../../../src/domain/agent/model/openclaw-intent.js';
import { container } from '../../../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../../src/interface/middleware/with-rate-limit.js';
import { withServiceSecret } from '../../../../../src/interface/middleware/with-service-secret.js';
import { Response } from '../../../../../src/interface/response.js';
import { z } from 'zod';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/v1/agent/openclaw/intent/create — telegram-bot worker mints
 * a confirmation intent.
 *
 * Auth: shared service secret in `Authorization: Bearer <secret>`. The
 * worker holds `TELEGRAM_BOT_SERVICE_SECRET`; rotation rotates the
 * worker's env var and the backend's env var atomically. The user is
 * identified by `userId` in the request body — the worker resolves it
 * from the `telegram_links` table before calling, so the userId here is
 * already authenticated by the telegram_links binding.
 */
const CreateRequestDtoSchema = CreateOpenClawIntentDtoSchema.extend({
  userId: z.string().min(1).max(64),
});

const useCase = new CreateOpenClawIntentUseCase(container.openclawIntentRepo);

const handler = createHandler({
  operationName: 'CreateOpenClawIntent',
  schema: CreateRequestDtoSchema,
  execute: async (dto) => {
    const result = await useCase.execute({
      userId: dto.userId,
      kind:
        dto.kind === 'buy' ? OpenClawIntentKind.Buy : OpenClawIntentKind.Claim,
      amountUsd6: BigInt(dto.amountUsd6),
      payload: {
        token: dto.payload.token as `0x${string}`,
        summary: dto.payload.summary,
        ...(dto.payload.issuerLabel ? { issuerLabel: dto.payload.issuerLabel } : {}),
        ...(dto.payload.escrowId ? { escrowId: dto.payload.escrowId } : {}),
      },
      ...(dto.telegramChatId ? { telegramChatId: dto.telegramChatId } : {}),
    });
    return Response.created({
      intent: {
        intentId: result.intent.intentId,
        kind: result.intent.kind,
        tier: result.intent.tier,
        status: result.intent.status,
        amountUsd6: result.intent.amountUsd6.toString(),
        intentHash: result.intent.intentHash,
        expiresAt: result.intent.expiresAt.toISOString(),
      },
      ...(result.otp ? { otp: result.otp } : {}),
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

// 60 mints / minute — generous because a healthy bot might process a
// burst when an investor lists multiple buy intents. Per-IP throttle
// because the bot worker has a stable egress IP per deployment.
export default withCors(
  withRateLimit(
    { maxRequests: 60, windowSeconds: 60 },
    withServiceSecret({ envVar: 'TELEGRAM_BOT_SERVICE_SECRET', serviceName: 'telegram-bot' }, router),
  ),
);
