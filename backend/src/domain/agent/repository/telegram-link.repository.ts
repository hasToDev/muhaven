import type { TelegramLink, TelegramLinkCode } from '../model/telegram-link.js';

export interface IssueTelegramLinkCodeInput {
  linkCode: string;
  userId: string;
  expiresAt: Date;
  now: Date;
}

export interface ConsumeTelegramLinkCodeInput {
  linkCode: string;
  telegramChatId: string;
  telegramUserId: string;
  telegramUsername: string | null;
  now: Date;
}

export interface ITelegramLinkCodeRepository {
  issue(input: IssueTelegramLinkCodeInput): Promise<TelegramLinkCode>;
  /**
   * Atomic consume — flips `consumedAt` only if the row is unconsumed
   * and unexpired. Returns the consumed row, or null if no eligible row
   * matched (already consumed, expired, or not found).
   */
  consume(input: ConsumeTelegramLinkCodeInput): Promise<TelegramLinkCode | null>;
  findByCode(linkCode: string): Promise<TelegramLinkCode | null>;
}

export interface ITelegramLinkRepository {
  upsertLink(link: TelegramLink): Promise<void>;
  findByChatId(telegramChatId: string): Promise<TelegramLink | null>;
  /**
   * Look up by Telegram `user.id` — used by the Mini App initData path
   * (initData carries `user.id` but not `chat.id`). Distinct from
   * `findByChatId` because the protocol does not guarantee equality.
   */
  findByTelegramUserId(telegramUserId: string): Promise<TelegramLink | null>;
  findByUserId(userId: string): Promise<TelegramLink[]>;
  /** Mark unlinked. Returns the updated row, or null if not active. */
  unlink(telegramChatId: string, now: Date): Promise<TelegramLink | null>;
  touchLastActive(telegramChatId: string, now: Date): Promise<void>;
}
