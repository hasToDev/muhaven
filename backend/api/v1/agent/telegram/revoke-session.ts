import {
  TelegramRevokeSessionDtoSchema,
} from '../../../../src/application/dto/agent/openclaw.dto.js';
import {
  RevokeActiveSessionsForChatUseCase,
} from '../../../../src/application/use-case/agent/policy/revoke-active-sessions-for-chat.use-case.js';
import {
  RevokeScopedSessionUseCase,
} from '../../../../src/application/use-case/agent/policy/revoke-scoped-session.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import { createHandler, sendResponse } from '../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withRateLimit } from '../../../../src/interface/middleware/with-rate-limit.js';
import { withServiceSecret } from '../../../../src/interface/middleware/with-service-secret.js';
import { Response } from '../../../../src/interface/response.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/v1/agent/telegram/revoke-session — telegram-bot worker
 * forwards a `/revoke_session` command from a linked Telegram user.
 *
 * Wave 5 Option D · C5 — the phone kill-switch. Resolves the chat to its
 * bound MuHaven user and revokes EVERY active scoped session for that
 * user (surface-agnostic). This is the SOFT revoke — the mirror-row flip
 * the shipped per-buy gate + MCP mirror already enforce; the on-chain
 * validator uninstall (C6) stays deferred.
 *
 * Auth: shared `TELEGRAM_BOT_SERVICE_SECRET` (same gate as the OpenClaw
 * `link/consume` + `intent/confirm-inline` worker endpoints). The chat
 * binding is the sole authority for whose sessions are revoked — there
 * is no user-supplied sessionId — so a service-secret holder cannot
 * target an arbitrary user.
 *
 * Responses:
 *   200 `{ revoked, found }` — `found` active sessions targeted; `revoked`
 *                          flipped active → revoked here (revoked may be <
 *                          found if a concurrent revoke won the race — every
 *                          found session is terminal regardless).
 *   404 — chat not linked (bot → "link your account first").
 *   409 — no active session (bot → "already off").
 *   503 — `TELEGRAM_BOT_SERVICE_SECRET` unset (worker integration off).
 */
const useCase = new RevokeActiveSessionsForChatUseCase(
  container.telegramLinkRepo,
  container.scopedSessionRepo,
  new RevokeScopedSessionUseCase(
    container.scopedSessionRepo,
    container.appendAuditEvent,
  ),
);

const handler = createHandler({
  operationName: 'TelegramRevokeScopedSession',
  schema: TelegramRevokeSessionDtoSchema,
  execute: async (dto) => {
    const result = await useCase.execute({ telegramChatId: dto.telegramChatId });
    return Response.ok({ revoked: result.revoked, found: result.found });
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'POST') {
    sendResponse(res, Response.methodNotAllowed('POST'));
    return;
  }
  return handler(req, res);
};

export default withCors(
  withRateLimit(
    { maxRequests: 30, windowSeconds: 60 },
    withServiceSecret(
      { envVar: 'TELEGRAM_BOT_SERVICE_SECRET', serviceName: 'telegram-bot' },
      router,
    ),
  ),
);
