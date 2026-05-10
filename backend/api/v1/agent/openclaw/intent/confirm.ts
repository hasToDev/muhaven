import {
  ConfirmOpenClawIntentDtoSchema,
} from '../../../../../src/application/dto/agent/openclaw.dto.js';
import {
  ConfirmOpenClawIntentUseCase,
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

/**
 * POST /api/v1/agent/openclaw/intent/confirm — confirm a pending intent.
 *
 * Two authentication paths converge here:
 *   1. Dashboard / `/agent/confirm` — JWT-authenticated user. The
 *      authenticated userId must match the intent's userId.
 *   2. Mini App — `telegramInitData` query string (HMAC-verified
 *      against the bot token). The verified Telegram user.id is matched
 *      against `telegram_links.user_id` to resolve a MuHaven userId.
 *
 * Both paths share the same use case; routing decides which auth
 * mechanism is required based on intent tier:
 *   - inline → JWT auth (Telegram bot worker calls a separate endpoint)
 *   - mini_app_otp → init-data + OTP
 *   - passkey_deeplink → JWT auth (dashboard)
 *
 * The route accepts both auth shapes for `mini_app_otp` (Mini App init
 * data takes precedence) so a user can fall back to the dashboard if the
 * Mini App is unavailable.
 */
const intentRepo = container.openclawIntentRepo;
const linkRepo = container.telegramLinkRepo;
const auditUseCase = new AppendAuditEventUseCase(container.agentAuditRepo);
const confirmUseCase = new ConfirmOpenClawIntentUseCase(
  intentRepo,
  auditUseCase,
  container.openClawIntentEventsChannel,
);

const handler = createHandler({
  operationName: 'ConfirmOpenClawIntent',
  schema: ConfirmOpenClawIntentDtoSchema,
  execute: async (dto, _req, authPayload) => {
    let resolvedUserId: string | null = authPayload?.userId ?? null;
    let source: 'mini_app' | 'dashboard_passkey' | undefined;

    if (dto.telegramInitData) {
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
      // C-3: resolve by Telegram user.id (not chat.id) — initData
      // carries `user.id`, the protocol does not guarantee
      // user.id == chat.id outside private chats.
      const link = await linkRepo.findByTelegramUserId(verified.userId);
      if (!link || !link.isActive()) {
        throw ApplicationHttpError.unauthorized('telegram chat not linked to MuHaven');
      }
      resolvedUserId = link.userId;
      // H-1: source is server-derived from the auth path. The DTO
      // field is intentionally NOT consulted here so a JWT holder can't
      // mark a passkey-deeplink confirm as `telegram_inline` to confuse
      // the audit trail.
      source = 'mini_app';
    } else if (!resolvedUserId) {
      throw ApplicationHttpError.unauthorized('Unauthorized');
    } else {
      // H-1: server-derived. JWT-only ⇒ dashboard_passkey hop.
      source = 'dashboard_passkey';
    }

    // H-2 (Wave 4 stub, Wave 5 will replace with real WebAuthn check):
    // For the dashboard / passkey-deeplink tier, require a non-empty
    // `passkeyAssertion`. The current verification is presence-only —
    // it documents the future contract without shipping a half-baked
    // WebAuthn integration. Wave 5 plugs in challenge-mint + assertion
    // verification against the user's registered authenticator.
    if (source === 'dashboard_passkey') {
      const existing = await intentRepo.findById(dto.intentId);
      if (existing && existing.tier === 'passkey_deeplink') {
        if (!dto.passkeyAssertion || dto.passkeyAssertion.length === 0) {
          throw ApplicationHttpError.unauthorized('passkey assertion required for >$5K tier');
        }
      }
    }

    const intent = await confirmUseCase.execute({
      intentId: dto.intentId,
      userId: resolvedUserId,
      ...(dto.otp ? { otp: dto.otp } : {}),
      ...(source ? { source } : {}),
    });

    return Response.ok({
      intent: {
        intentId: intent.intentId,
        kind: intent.kind,
        tier: intent.tier,
        status: intent.status,
        amountUsd6: intent.amountUsd6.toString(),
        intentHash: intent.intentHash,
        confirmedAt: intent.confirmedAt?.toISOString(),
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

// Optional auth: dashboard tier confirms via JWT, Mini App tier via
// initData. We compose `withAuth` permissively — if no JWT is present
// we still let the request through; the use case throws
// `Unauthorized` when neither path resolves a userId.
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
