/**
 * Telegram-account ↔ MuHaven-user link (Wave 4 P4).
 *
 * Two-phase enrollment:
 *   1. User taps "Link Telegram" in the dashboard → backend mints a
 *      single-use link code with a short TTL (~5 min) and renders it.
 *   2. User messages the bot with `/start <linkCode>`. Bot calls the
 *      backend; backend consumes the code atomically and binds
 *      `telegramChatId ↔ userId`.
 *
 * Subsequent inbound messages from the same chatId are authenticated by
 * the binding row.
 *
 * The same userId may have multiple active chat bindings (e.g., personal
 * + family chat) — the table is intentionally not unique on `userId`.
 * Distinct `telegramChatId` is unique because Telegram never reuses chat
 * ids.
 *
 * Unlinking is a regular UPDATE that sets `unlinkedAt` and stops
 * authenticating the chat — no row deletion so the audit log keeps the
 * historical link.
 */

export interface TelegramLinkCodeProps {
  linkCode: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  consumedByChatId: string | null;
  createdAt: Date;
}

export class TelegramLinkCode implements TelegramLinkCodeProps {
  readonly linkCode: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly consumedByChatId: string | null;
  readonly createdAt: Date;

  constructor(props: TelegramLinkCodeProps) {
    this.linkCode = props.linkCode;
    this.userId = props.userId;
    this.expiresAt = props.expiresAt;
    this.consumedAt = props.consumedAt;
    this.consumedByChatId = props.consumedByChatId;
    this.createdAt = props.createdAt;
  }

  isExpired(now: Date = new Date()): boolean {
    return now.getTime() >= this.expiresAt.getTime();
  }

  isConsumed(): boolean {
    return this.consumedAt !== null;
  }
}

export interface TelegramLinkProps {
  /**
   * Telegram chat id where the bot received the `/start` command. In
   * private chats this equals `telegramUserId` — but the protocol does
   * NOT guarantee equality, so we store both. Bot worker callback
   * queries dispatch on `chat.id`; Mini App `initData` exposes only
   * `user.id`.
   */
  telegramChatId: string;
  /** Telegram user.id (the verified `user.id` field from `from` / Mini
   *  App initData). Always present — set at link consume time. */
  telegramUserId: string;
  userId: string;
  /** Telegram username at link time — informational, may go stale. */
  telegramUsername: string | null;
  linkedAt: Date;
  unlinkedAt: Date | null;
  /** Last seen activity for stale-link auditing. */
  lastActiveAt: Date | null;
}

export class TelegramLink implements TelegramLinkProps {
  readonly telegramChatId: string;
  readonly telegramUserId: string;
  readonly userId: string;
  readonly telegramUsername: string | null;
  readonly linkedAt: Date;
  readonly unlinkedAt: Date | null;
  readonly lastActiveAt: Date | null;

  constructor(props: TelegramLinkProps) {
    this.telegramChatId = props.telegramChatId;
    this.telegramUserId = props.telegramUserId;
    this.userId = props.userId;
    this.telegramUsername = props.telegramUsername;
    this.linkedAt = props.linkedAt;
    this.unlinkedAt = props.unlinkedAt;
    this.lastActiveAt = props.lastActiveAt;
  }

  isActive(): boolean {
    return this.unlinkedAt === null;
  }
}
