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

function generateLinkCode(): string {
  const buf = randomBytes(8);
  let out = '';
  for (const b of buf) {
    out += LINK_CODE_ALPHABET[b % LINK_CODE_ALPHABET.length];
  }
  return out;
}

export type { TelegramLink, TelegramLinkCode };
