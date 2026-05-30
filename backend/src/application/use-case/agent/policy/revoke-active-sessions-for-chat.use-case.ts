import { ApplicationHttpError } from '../../../../core/errors.js';
import { getLogger } from '../../../../core/logger.js';
import type { IScopedSessionRepository } from '../../../../domain/agent/repository/scoped-session.repository.js';
import type { ITelegramLinkRepository } from '../../../../domain/agent/repository/telegram-link.repository.js';
import type { RevokeScopedSessionUseCase } from './revoke-scoped-session.use-case.js';

/**
 * Wave 5 Option D · C5 — Telegram `/revoke_session` phone kill-switch.
 *
 * Resolves a Telegram `chatId` to its bound MuHaven user, then revokes
 * EVERY active scoped session for that user (surface-agnostic — a phone
 * kill-switch kills everything, not just the `mcp` surface scoped
 * sessions are hard-locked under today). This is the SOFT revoke: it
 * flips each mirror row to `status='revoked'`, which the shipped per-buy
 * gate (`EncryptSharesForPurchaseUseCase` → 403) and the MCP mirror
 * (`scoped-session-mirror` refuses to install a non-active snapshot)
 * already make authoritative. The on-chain validator uninstall (C6)
 * stays deferred.
 *
 * **Auth model.** The route-layer service-secret gate proves the caller
 * is the trusted telegram-bot worker; the `chatId` is the ONLY
 * authority for *whose* sessions are revoked. There is no user-supplied
 * sessionId — a service-secret holder therefore cannot target an
 * arbitrary user's session, only the user bound to a chat it can name.
 * The bot worker, in turn, only ever forwards the chat that issued the
 * command (with its own `chat.id === from.id` guard), so a group-chat
 * member cannot revoke another user.
 *
 * **Idempotency.** Reuses `RevokeScopedSessionUseCase` per session, which
 * is the same use-case the dashboard DELETE drives — so the audit chain
 * (`ScopedSessionRevoked` row per session, anchored on the mint surface)
 * is identical regardless of which front door (dashboard / Telegram)
 * fired the revoke. A session that races to terminal between the lookup
 * and the per-session revoke surfaces as a benign 409 from the inner
 * use-case and is skipped — the kill-switch's goal (the session is off)
 * is already met, and one raced row must not abort revoking the rest.
 */
export interface RevokeActiveSessionsForChatInput {
  telegramChatId: string;
  now?: Date;
}

export interface RevokeActiveSessionsForChatResult {
  userId: string;
  /** Active sessions found at lookup time (the kill-switch's target set). */
  found: number;
  /** Sessions this call actually flipped active → revoked. May be < `found`
   *  if a concurrent revoke won a race (counted as already off, not as this
   *  call's work). On a 200, every `found` session IS terminal — either
   *  revoked here or already-terminal via the race — because a genuine
   *  mid-loop failure re-throws (→ non-200) rather than returning partial. */
  revoked: number;
}

export class RevokeActiveSessionsForChatUseCase {
  constructor(
    private readonly telegramLinkRepo: ITelegramLinkRepository,
    private readonly scopedRepo: IScopedSessionRepository,
    private readonly revokeUseCase: RevokeScopedSessionUseCase,
  ) {}

  async execute(
    input: RevokeActiveSessionsForChatInput,
  ): Promise<RevokeActiveSessionsForChatResult> {
    const now = input.now ?? new Date();

    const link = await this.telegramLinkRepo.findByChatId(input.telegramChatId);
    if (!link || !link.isActive()) {
      // 404 — chat not linked (or unlinked). The bot maps this to "link
      // your account first". Same 404 for never-linked and unlinked so
      // the response doesn't distinguish the two for the holder of a
      // (presumed) leaked service secret.
      throw ApplicationHttpError.notFound(
        'telegram chat is not linked to a MuHaven account',
      );
    }

    const nowSec = Math.floor(now.getTime() / 1000);
    const sessions = await this.scopedRepo.findActiveByUser(link.userId, nowSec);
    if (sessions.length === 0) {
      // 409 — nothing live to revoke. The bot maps this to "autonomous
      // trading is already off".
      throw ApplicationHttpError.conflict(
        'no active autonomous session to revoke',
      );
    }

    let revoked = 0;
    for (const session of sessions) {
      try {
        await this.revokeUseCase.execute({
          userId: link.userId,
          sessionId: session.sessionId,
          now,
        });
        revoked += 1;
      } catch (err) {
        if (err instanceof ApplicationHttpError && err.statusCode === 409) {
          // Concurrent revoke (dashboard / a second /revoke_session)
          // already flipped this row to terminal between the lookup and
          // here. Benign for a kill-switch — the session is off. Skip,
          // but log so the skip decision stays greppable alongside the
          // inner use-case's orphan-reconciliation posture (the inner 409
          // does NOT re-emit a missed audit row).
          getLogger('RevokeActiveSessionsForChat').debug(
            { sessionId: session.sessionId, userId: link.userId },
            'scoped session already terminal at revoke time (race) — skipping',
          );
          continue;
        }
        if (err instanceof ApplicationHttpError && err.statusCode === 404) {
          // Unreachable in practice (we just read the row under the same
          // userId), but if the row vanished, treat as already-gone
          // rather than failing the whole kill-switch. Log so a genuine
          // invariant break is greppable.
          getLogger('RevokeActiveSessionsForChat').warn(
            { sessionId: session.sessionId, userId: link.userId },
            'scoped session vanished between lookup and revoke — skipping',
          );
          continue;
        }
        // Anything else (e.g. an audit-table outage surfaced as a 500 by
        // the inner use-case) is a genuine failure — re-throw so the
        // operator sees it. Sessions already revoked in this loop stay
        // revoked (the kill-switch is partially applied, fail-safe
        // direction: more off, not less).
        throw err;
      }
    }

    return { userId: link.userId, found: sessions.length, revoked };
  }
}
