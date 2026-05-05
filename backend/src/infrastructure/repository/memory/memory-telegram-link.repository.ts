import type {
  ConsumeTelegramLinkCodeInput,
  ITelegramLinkCodeRepository,
  ITelegramLinkRepository,
  IssueTelegramLinkCodeInput,
} from '../../../domain/agent/repository/telegram-link.repository.js';
import {
  TelegramLink,
  TelegramLinkCode,
} from '../../../domain/agent/model/telegram-link.js';

export class MemoryTelegramLinkCodeRepository implements ITelegramLinkCodeRepository {
  private readonly store = new Map<string, TelegramLinkCode>();

  async issue(input: IssueTelegramLinkCodeInput): Promise<TelegramLinkCode> {
    if (this.store.has(input.linkCode)) {
      throw new Error(`link code collision: ${input.linkCode}`);
    }
    const code = new TelegramLinkCode({
      linkCode: input.linkCode,
      userId: input.userId,
      expiresAt: input.expiresAt,
      consumedAt: null,
      consumedByChatId: null,
      createdAt: input.now,
    });
    this.store.set(input.linkCode, code);
    return code;
  }

  async consume(input: ConsumeTelegramLinkCodeInput): Promise<TelegramLinkCode | null> {
    const existing = this.store.get(input.linkCode);
    if (!existing) return null;
    if (existing.consumedAt !== null) return null;
    if (existing.isExpired(input.now)) return null;
    void input.telegramUserId; // captured by the link table, not the code row
    const consumed = new TelegramLinkCode({
      ...existing,
      consumedAt: input.now,
      consumedByChatId: input.telegramChatId,
    });
    this.store.set(input.linkCode, consumed);
    return consumed;
  }

  async findByCode(linkCode: string): Promise<TelegramLinkCode | null> {
    return this.store.get(linkCode) ?? null;
  }
}

export class MemoryTelegramLinkRepository implements ITelegramLinkRepository {
  private readonly store = new Map<string, TelegramLink>();

  async upsertLink(link: TelegramLink): Promise<void> {
    this.store.set(link.telegramChatId, link);
  }

  async findByChatId(telegramChatId: string): Promise<TelegramLink | null> {
    const link = this.store.get(telegramChatId) ?? null;
    if (!link || !link.isActive()) return link;
    return link;
  }

  async findByTelegramUserId(telegramUserId: string): Promise<TelegramLink | null> {
    for (const link of this.store.values()) {
      if (link.telegramUserId === telegramUserId && link.isActive()) return link;
    }
    return null;
  }

  async findByUserId(userId: string): Promise<TelegramLink[]> {
    return Array.from(this.store.values()).filter((l) => l.userId === userId);
  }

  async unlink(telegramChatId: string, now: Date): Promise<TelegramLink | null> {
    const existing = this.store.get(telegramChatId);
    if (!existing || !existing.isActive()) return null;
    const unlinked = new TelegramLink({ ...existing, unlinkedAt: now });
    this.store.set(telegramChatId, unlinked);
    return unlinked;
  }

  async touchLastActive(telegramChatId: string, now: Date): Promise<void> {
    const existing = this.store.get(telegramChatId);
    if (!existing || !existing.isActive()) return;
    this.store.set(telegramChatId, new TelegramLink({ ...existing, lastActiveAt: now }));
  }
}
