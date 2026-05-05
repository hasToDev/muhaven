import { and, eq, gt, isNull } from 'drizzle-orm';
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
import { telegramLinkCodes, telegramLinks } from './schema.js';
import type { Db } from './db.js';

export class PgTelegramLinkCodeRepository implements ITelegramLinkCodeRepository {
  constructor(private readonly db: Db) {}

  async issue(input: IssueTelegramLinkCodeInput): Promise<TelegramLinkCode> {
    const inserted = await this.db
      .insert(telegramLinkCodes)
      .values({
        linkCode: input.linkCode,
        userId: input.userId,
        expiresAt: input.expiresAt,
        createdAt: input.now,
      })
      .returning();
    return this.toDomainCode(inserted[0]);
  }

  async consume(input: ConsumeTelegramLinkCodeInput): Promise<TelegramLinkCode | null> {
    // Atomic conditional UPDATE.
    const updated = await this.db
      .update(telegramLinkCodes)
      .set({
        consumedAt: input.now,
        consumedByChatId: input.telegramChatId,
      })
      .where(
        and(
          eq(telegramLinkCodes.linkCode, input.linkCode),
          isNull(telegramLinkCodes.consumedAt),
          gt(telegramLinkCodes.expiresAt, input.now),
        ),
      )
      .returning();
    return updated.length > 0 ? this.toDomainCode(updated[0]) : null;
  }

  async findByCode(linkCode: string): Promise<TelegramLinkCode | null> {
    const row = await this.db.query.telegramLinkCodes.findFirst({
      where: eq(telegramLinkCodes.linkCode, linkCode),
    });
    return row ? this.toDomainCode(row) : null;
  }

  private toDomainCode(row: typeof telegramLinkCodes.$inferSelect): TelegramLinkCode {
    return new TelegramLinkCode({
      linkCode: row.linkCode,
      userId: row.userId,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
      consumedByChatId: row.consumedByChatId,
      createdAt: row.createdAt,
    });
  }
}

export class PgTelegramLinkRepository implements ITelegramLinkRepository {
  constructor(private readonly db: Db) {}

  async upsertLink(link: TelegramLink): Promise<void> {
    await this.db
      .insert(telegramLinks)
      .values({
        telegramChatId: link.telegramChatId,
        telegramUserId: link.telegramUserId,
        userId: link.userId,
        telegramUsername: link.telegramUsername,
        linkedAt: link.linkedAt,
        unlinkedAt: link.unlinkedAt,
        lastActiveAt: link.lastActiveAt,
      })
      .onConflictDoUpdate({
        target: telegramLinks.telegramChatId,
        set: {
          telegramUserId: link.telegramUserId,
          userId: link.userId,
          telegramUsername: link.telegramUsername,
          linkedAt: link.linkedAt,
          unlinkedAt: link.unlinkedAt,
          lastActiveAt: link.lastActiveAt,
        },
      });
  }

  async findByChatId(telegramChatId: string): Promise<TelegramLink | null> {
    const row = await this.db.query.telegramLinks.findFirst({
      where: eq(telegramLinks.telegramChatId, telegramChatId),
    });
    return row ? this.toDomain(row) : null;
  }

  async findByTelegramUserId(telegramUserId: string): Promise<TelegramLink | null> {
    const row = await this.db.query.telegramLinks.findFirst({
      where: and(
        eq(telegramLinks.telegramUserId, telegramUserId),
        isNull(telegramLinks.unlinkedAt),
      ),
    });
    return row ? this.toDomain(row) : null;
  }

  async findByUserId(userId: string): Promise<TelegramLink[]> {
    const rows = await this.db.query.telegramLinks.findMany({
      where: eq(telegramLinks.userId, userId),
    });
    return rows.map((r) => this.toDomain(r));
  }

  async unlink(telegramChatId: string, now: Date): Promise<TelegramLink | null> {
    const updated = await this.db
      .update(telegramLinks)
      .set({ unlinkedAt: now })
      .where(
        and(
          eq(telegramLinks.telegramChatId, telegramChatId),
          isNull(telegramLinks.unlinkedAt),
        ),
      )
      .returning();
    return updated.length > 0 ? this.toDomain(updated[0]) : null;
  }

  async touchLastActive(telegramChatId: string, now: Date): Promise<void> {
    await this.db
      .update(telegramLinks)
      .set({ lastActiveAt: now })
      .where(
        and(
          eq(telegramLinks.telegramChatId, telegramChatId),
          isNull(telegramLinks.unlinkedAt),
        ),
      );
  }

  private toDomain(row: typeof telegramLinks.$inferSelect): TelegramLink {
    return new TelegramLink({
      telegramChatId: row.telegramChatId,
      telegramUserId: row.telegramUserId,
      userId: row.userId,
      telegramUsername: row.telegramUsername,
      linkedAt: row.linkedAt,
      unlinkedAt: row.unlinkedAt,
      lastActiveAt: row.lastActiveAt,
    });
  }
}
