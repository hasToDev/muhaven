import { randomBytes } from 'node:crypto';
import { ApplicationHttpError } from '../../../../core/errors.js';
import {
  TelegramLink,
  TelegramLinkCode,
} from '../../../../domain/agent/model/telegram-link.js';
import type {
  ITelegramLinkCodeRepository,
  ITelegramLinkRepository,
} from '../../../../domain/agent/repository/telegram-link.repository.js';

const LINK_CODE_TTL_SEC = 5 * 60;
// 8-char base32 — same alphabet as the device-flow user code, picked for
// typability when the user pastes the bot start URL on a phone.
const LINK_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export class IssueTelegramLinkCodeUseCase {
  constructor(private readonly codeRepo: ITelegramLinkCodeRepository) {}

  async execute(userId: string, now: Date = new Date()): Promise<{
    linkCode: string;
    expiresInSec: number;
    botStartUrl: (botUsername: string) => string;
  }> {
    const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_SEC * 1000);

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const linkCode = generateLinkCode();
      try {
        await this.codeRepo.issue({ linkCode, userId, expiresAt, now });
        return {
          linkCode,
          expiresInSec: LINK_CODE_TTL_SEC,
          botStartUrl: (botUsername) =>
            `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(linkCode)}`,
        };
      } catch (err) {
        lastErr = err;
      }
    }
    throw new ApplicationHttpError(
      503,
      `failed to issue link code after retries: ${lastErr instanceof Error ? lastErr.message : ''}`,
    );
  }
}

export interface ConsumeTelegramLinkInput {
  linkCode: string;
  telegramChatId: string;
  telegramUserId: string;
  telegramUsername: string | null;
  now?: Date;
}

export class ConsumeTelegramLinkUseCase {
  constructor(
    private readonly codeRepo: ITelegramLinkCodeRepository,
    private readonly linkRepo: ITelegramLinkRepository,
  ) {}

  async execute(input: ConsumeTelegramLinkInput): Promise<TelegramLink> {
    const now = input.now ?? new Date();
    const consumed = await this.codeRepo.consume({
      linkCode: input.linkCode,
      telegramChatId: input.telegramChatId,
      telegramUserId: input.telegramUserId,
      telegramUsername: input.telegramUsername,
      now,
    });
    if (!consumed) {
      throw ApplicationHttpError.badRequest('invalid or expired link code');
    }
    const link = new TelegramLink({
      telegramChatId: input.telegramChatId,
      telegramUserId: input.telegramUserId,
      userId: consumed.userId,
      telegramUsername: input.telegramUsername,
      linkedAt: now,
      unlinkedAt: null,
      lastActiveAt: now,
    });
    await this.linkRepo.upsertLink(link);
    return link;
  }
}

export class FindTelegramLinkUseCase {
  constructor(private readonly linkRepo: ITelegramLinkRepository) {}

  async execute(telegramChatId: string): Promise<TelegramLink | null> {
    const link = await this.linkRepo.findByChatId(telegramChatId);
    if (!link || !link.isActive()) return null;
    return link;
  }
}

/**
 * Plan A (2026-05-15) — dashboard-driven unlink.
 *
 * The dashboard's LinkTelegramModal exposes an "Unlink" CTA in the
 * linked-state branch. Without a server-side verb the only way to
 * unlink was to message the bot directly — fine for power users, but
 * a UX gap for everyone else. The use-case mutates ONLY links owned
 * by the calling userId (defense against a `chatId` from another
 * user's URL being passed in), so the route handler can take a
 * chatId in the body without worrying about authorization drift.
 *
 * Semantics:
 *   - chatId omitted → unlinks EVERY active row owned by the user
 *     (Plan A's default surface — the sidebar pill only reflects the
 *     "most-recent" link, so unlinking should clear the whole set).
 *   - chatId provided → unlinks only that one (future surface for a
 *     multi-link manager UI).
 *   - No active rows → return { unlinkedCount: 0 } rather than 404;
 *     the operation is idempotent.
 */
export interface UnlinkTelegramInput {
  userId: string;
  telegramChatId?: string;
  now?: Date;
}

export interface UnlinkTelegramResult {
  unlinkedCount: number;
}

export class UnlinkTelegramUseCase {
  constructor(private readonly linkRepo: ITelegramLinkRepository) {}

  async execute(input: UnlinkTelegramInput): Promise<UnlinkTelegramResult> {
    const now = input.now ?? new Date();
    const rows = await this.linkRepo.findByUserId(input.userId);
    const targets = rows
      .filter((r) => r.isActive())
      .filter((r) => !input.telegramChatId || r.telegramChatId === input.telegramChatId);
    if (targets.length === 0) {
      return { unlinkedCount: 0 };
    }
    let count = 0;
    for (const row of targets) {
      const updated = await this.linkRepo.unlink(row.telegramChatId, now);
      if (updated) count += 1;
    }
    return { unlinkedCount: count };
  }
}

function generateLinkCode(): string {
  const buf = randomBytes(8);
  let out = '';
  for (const b of buf) {
    out += LINK_CODE_ALPHABET[b % LINK_CODE_ALPHABET.length];
  }
  return out;
}

export type { TelegramLink, TelegramLinkCode };
