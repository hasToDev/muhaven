/**
 * MuHaven Telegram bot logic — three-tier confirmation surface for the
 * OpenClaw skill.
 *
 * **Hardening invariants** (do NOT relax without ADR):
 *   - Bot worker NEVER signs a UserOp. It forwards intents to the
 *     backend; the backend / broker / kernel does the signing.
 *   - Bot worker NEVER sees the user's JWT. The JWT lives in
 *     `muhaven-broker`'s keystore on the user's local machine.
 *   - All state-mutating callbacks check that the chat_id is bound to
 *     a MuHaven user via `telegram_links` before acting.
 *   - Free-form text messages NEVER reach the LLM. The bot accepts
 *     `/start <code>`, `/link`, `/help`, `/pause`, `/unlink`, and the
 *     intent-callback queries — anything else is rejected with a
 *     guidance message. Free-form intent generation comes from the
 *     LLM-side OpenClaw skill, not the bot worker.
 *   - Inline tier confirms are service-secret authenticated; mini-app
 *     and dashboard tiers route through user auth.
 *
 * The dispatcher pattern: a `BotMessageHandler` accepts a Telegram
 * `Update` (already validated by the webhook layer) and the
 * `BackendClient`, returns a list of side-effects (`SendMessageEffect |
 * AnswerCallbackEffect | EditMarkupEffect`). Side-effects are applied
 * by the caller — keeps the handler pure and unit-testable.
 */

import {
  escapeMarkdownV2,
  type InlineKeyboardMarkup,
  type SendMessageInput,
  type AnswerCallbackQueryInput,
  type EditMessageReplyMarkupInput,
} from './telegram-api.js';
import { BackendClient, BackendClientError } from './backend-client.js';

// ── Telegram Update shape (subset we consume) ────────────────────────

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  username?: string;
  title?: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
  chat_instance: string;
}

// ── Side-effect ADTs ─────────────────────────────────────────────────

export interface SendMessageEffect {
  kind: 'send';
  payload: SendMessageInput;
}
export interface AnswerCallbackEffect {
  kind: 'answer_callback';
  payload: AnswerCallbackQueryInput;
}
export interface EditMarkupEffect {
  kind: 'edit_markup';
  payload: EditMessageReplyMarkupInput;
}

export type BotEffect = SendMessageEffect | AnswerCallbackEffect | EditMarkupEffect;

// ── Callback-data schema ─────────────────────────────────────────────

export type CallbackKind = 'cnf' | 'dny' | 'ext';
export interface CallbackData {
  kind: CallbackKind;
  intentId: string;
}

const CB_INTENT_RE = /^(cnf|dny|ext):(oci_[A-Z0-9]{26})$/;

export function parseCallbackData(raw: string | undefined): CallbackData | null {
  if (!raw) return null;
  const m = CB_INTENT_RE.exec(raw);
  if (!m) return null;
  return { kind: m[1] as CallbackKind, intentId: m[2]! };
}

export function encodeCallbackData(d: CallbackData): string {
  return `${d.kind}:${d.intentId}`;
}

// ── Bot handler ──────────────────────────────────────────────────────

export interface BotHandlerOpts {
  backend: BackendClient;
  botUsername: string;
  miniAppUrl: string;
  dashboardUrl: string;
}

export class BotHandler {
  constructor(private readonly opts: BotHandlerOpts) {}

  async handleUpdate(update: TelegramUpdate): Promise<BotEffect[]> {
    if (update.message) {
      return this.handleMessage(update.message);
    }
    if (update.callback_query) {
      return this.handleCallback(update.callback_query);
    }
    // Other update types (edited_message, channel_post, etc.) are not
    // serviced — the webhook is registered with allowed_updates limited
    // to message + callback_query, but a future Telegram change might
    // ship one through. Drop silently.
    return [];
  }

  private async handleMessage(message: TelegramMessage): Promise<BotEffect[]> {
    if (!message.text) return [];
    if (message.chat.type !== 'private') {
      // Refuse to act in groups — the privacy boundary requires a
      // 1-to-1 chat. Group routing is a different security shape and
      // is deliberately out of scope.
      return [
        sendText(
          message.chat.id,
          'I only work in a private chat — please message me directly.',
        ),
      ];
    }
    const text = message.text.trim();
    const startMatch = /^\/start(?:\s+(\S+))?\s*$/.exec(text);
    if (startMatch) {
      const linkCode = startMatch[1];
      if (!linkCode) {
        return [
          sendText(
            message.chat.id,
            'Welcome to MuHaven\\. To link your account, open the dashboard, tap *Link Telegram*, then tap the link or scan the QR code\\. The link code expires in 5 minutes\\.',
          ),
        ];
      }
      return this.handleLink(message, linkCode);
    }
    if (text === '/help') {
      return [
        sendText(
          message.chat.id,
          this.helpMessage(),
        ),
      ];
    }
    if (text === '/pause') {
      return [
        sendText(
          message.chat.id,
          [
            'To pause your agent, open the dashboard and tap *Pause Agent* on the policy tab\\.',
            '',
            `[Open dashboard](${escapeMarkdownV2(this.opts.dashboardUrl)})`,
          ].join('\n'),
        ),
      ];
    }
    if (text === '/unlink') {
      return [
        sendText(
          message.chat.id,
          'To unlink your Telegram account, open the dashboard → Agent → Telegram → *Unlink*\\. The unlink takes effect immediately\\.',
        ),
      ];
    }
    // Free-form text — refuse politely. The LLM lives in the
    // user's OpenClaw skill on the host side, not in this bot worker.
    return [
      sendText(
        message.chat.id,
        [
          'I only respond to commands\\. Try /help to see the list\\.',
          '',
          'For chatting with the MuHaven agent, open the dashboard or use the OpenClaw skill on your computer\\.',
        ].join('\n'),
      ),
    ];
  }

  private async handleCallback(cb: TelegramCallbackQuery): Promise<BotEffect[]> {
    const chatId = cb.message?.chat.id;
    const chatType = cb.message?.chat.type;
    const messageId = cb.message?.message_id;
    if (chatId == null || messageId == null) {
      return [answerCallback(cb.id, 'No chat context.', true)];
    }
    // Defense-in-depth (M-2): even though messages in groups are rejected
    // up-stream, callback_query updates can fire in any chat type. Refuse
    // anything that isn't a 1:1 private chat.
    if (chatType !== 'private') {
      return [answerCallback(cb.id, 'Group callbacks are not supported.', true)];
    }
    // Defense-in-depth (C-2 + M-2): the tapping user MUST be the same
    // identity bound by `telegram_links` for this chat. In a private
    // chat the protocol guarantees `chat.id === from.id`, but a bot
    // added to a group with privacy mode disabled could surface a
    // mismatch — refuse before forwarding to the backend.
    if (cb.from.id !== chatId) {
      return [answerCallback(cb.id, 'Identity mismatch.', true)];
    }
    const data = parseCallbackData(cb.data);
    if (!data) {
      return [answerCallback(cb.id, 'Unrecognized button.', true)];
    }
    if (data.kind === 'ext') {
      // External button — the deep-link to the dashboard. Telegram
      // already opened the URL in the user's browser; we just clear
      // the spinner.
      return [answerCallback(cb.id)];
    }
    const tgChatId = String(chatId);
    const tgUserId = String(cb.from.id);
    if (data.kind === 'cnf') {
      try {
        await this.opts.backend.confirmIntent({
          intentId: data.intentId,
          expectedChatId: tgChatId,
          expectedUserId: tgUserId,
          source: 'telegram_inline',
        });
      } catch (err) {
        return [
          answerCallback(cb.id, this.friendlyBackendErrorAlert(err), true),
        ];
      }
      return [
        answerCallback(cb.id, 'Confirmed. Submitting on-chain.', false),
        editMarkup(chatId, messageId, undefined),
        sendText(
          chatId,
          '✅ Intent confirmed\\. The MuHaven backend is submitting your transaction; you will see the result in the dashboard activity feed within a few seconds\\.',
        ),
      ];
    }
    if (data.kind === 'dny') {
      try {
        await this.opts.backend.denyIntent({
          intentId: data.intentId,
          expectedChatId: tgChatId,
          expectedUserId: tgUserId,
          reason: 'user_denied',
        });
      } catch (err) {
        return [
          answerCallback(cb.id, this.friendlyBackendErrorAlert(err), true),
        ];
      }
      return [
        answerCallback(cb.id, 'Denied. No transaction submitted.', false),
        editMarkup(chatId, messageId, undefined),
        sendText(chatId, '✖\\uFE0F Intent denied\\. Nothing was submitted on\\-chain\\.'),
      ];
    }
    return [answerCallback(cb.id)];
  }

  private async handleLink(
    message: TelegramMessage,
    linkCode: string,
  ): Promise<BotEffect[]> {
    if (!/^[A-Z0-9]{8}$/.test(linkCode)) {
      return [
        sendText(
          message.chat.id,
          'That link code looks malformed\\. Re\\-issue it from the dashboard → Agent → Telegram\\.',
        ),
      ];
    }
    if (!message.from) {
      // Telegram always supplies `from` for /start in a private chat;
      // refusing here defends against a malformed update.
      return [
        sendText(
          message.chat.id,
          'Could not identify the requesting Telegram user\\. Try again from your private chat with the bot\\.',
        ),
      ];
    }
    try {
      const result = await this.opts.backend.consumeLinkCode({
        linkCode,
        telegramChatId: String(message.chat.id),
        telegramUserId: String(message.from.id),
        telegramUsername: message.from.username ?? null,
      });
      const userIdShort = result.link.userId.slice(0, 8);
      return [
        sendText(
          message.chat.id,
          [
            `✅ Linked\\! This chat is now bound to MuHaven user \`${escapeMarkdownV2(userIdShort)}\`\\.`,
            '',
            'You can now confirm OpenClaw intents from this chat\\. Try `/help` to see what I can do\\.',
          ].join('\n'),
        ),
      ];
    } catch (err) {
      const text =
        err instanceof BackendClientError && err.status === 400
          ? 'That link code is invalid or expired\\. Issue a fresh one from the dashboard\\.'
          : 'I could not link the account right now\\. Please try again in a minute\\.';
      return [sendText(message.chat.id, text)];
    }
  }

  /**
   * Render the inline-keyboard for an intent. Used by the message the
   * backend (or this bot) posts to the user with the intent preview.
   * Keep this pure — it does NOT call the API; the caller decides when
   * to send.
   */
  buildIntentKeyboard(
    intent: { intentId: string; tier: 'inline' | 'mini_app_otp' | 'passkey_deeplink' },
  ): InlineKeyboardMarkup {
    if (intent.tier === 'inline') {
      return {
        inline_keyboard: [
          [
            { text: '✅ Confirm', callback_data: encodeCallbackData({ kind: 'cnf', intentId: intent.intentId }) },
            { text: '✖\\uFE0F Deny', callback_data: encodeCallbackData({ kind: 'dny', intentId: intent.intentId }) },
          ],
        ],
      };
    }
    if (intent.tier === 'mini_app_otp') {
      const url = `${this.opts.miniAppUrl}?intent=${encodeURIComponent(intent.intentId)}`;
      return {
        inline_keyboard: [
          [{ text: '🔒 Open Mini App', web_app: { url } }],
          [
            { text: '✖\\uFE0F Deny', callback_data: encodeCallbackData({ kind: 'dny', intentId: intent.intentId }) },
          ],
        ],
      };
    }
    // passkey_deeplink — open the dashboard `/agent/confirm` page.
    const url = `${this.opts.dashboardUrl}/agent/confirm?intent=${encodeURIComponent(intent.intentId)}&from=telegram`;
    return {
      inline_keyboard: [
        [
          { text: '🔑 Confirm in dashboard', url },
        ],
        [
          { text: '✖\\uFE0F Deny', callback_data: encodeCallbackData({ kind: 'dny', intentId: intent.intentId }) },
        ],
      ],
    };
  }

  private helpMessage(): string {
    return [
      '*MuHaven bot* — confirmation surface for the OpenClaw skill\\.',
      '',
      'Commands:',
      '`/start <code>` — link this chat to your MuHaven account',
      '`/help` — show this message',
      '`/pause` — link to the dashboard pause control',
      '`/unlink` — instructions to unlink Telegram',
      '',
      'I am NOT a chat agent\\. To talk to the MuHaven agent, open the dashboard or use the OpenClaw skill on your computer\\.',
    ].join('\n');
  }

  private friendlyBackendErrorAlert(err: unknown): string {
    if (err instanceof BackendClientError) {
      if (err.status === 410) return 'Intent expired or already settled.';
      if (err.status === 409) return 'Conflict — try again from a fresh intent.';
      if (err.status === 403) return 'Not allowed.';
      if (err.status === 401) return 'Authentication issue — try /start again.';
      if (err.status === 404) return 'Intent not found.';
    }
    return 'Backend unavailable. Try again in a moment.';
  }
}

// ── Effect helpers ───────────────────────────────────────────────────

function sendText(
  chat_id: string | number,
  text: string,
  reply_markup?: InlineKeyboardMarkup,
): SendMessageEffect {
  return {
    kind: 'send',
    payload: {
      chat_id,
      text,
      parse_mode: 'MarkdownV2',
      ...(reply_markup ? { reply_markup } : {}),
      disable_web_page_preview: true,
    },
  };
}

function answerCallback(id: string, text?: string, alert = false): AnswerCallbackEffect {
  return {
    kind: 'answer_callback',
    payload: {
      callback_query_id: id,
      ...(text ? { text } : {}),
      ...(alert ? { show_alert: true } : {}),
    },
  };
}

function editMarkup(
  chat_id: string | number,
  message_id: number,
  reply_markup: InlineKeyboardMarkup | undefined,
): EditMarkupEffect {
  return {
    kind: 'edit_markup',
    payload: { chat_id, message_id, reply_markup },
  };
}
