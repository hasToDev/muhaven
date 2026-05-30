/**
 * Tiny Telegram Bot API client (Wave 4 P4).
 *
 * No third-party dep — Bot API is a stable HTTP+JSON surface and we only
 * need three methods: `sendMessage`, `answerCallbackQuery`,
 * `editMessageReplyMarkup`. Hand-rolled to keep supply-chain surface
 * minimal (P3 lessons from the Anthropic MCP SDK CVE).
 */

export interface InlineKeyboardButton {
  text: string;
  /** Callback data (≤64 bytes) — bot worker dispatches on this. */
  callback_data?: string;
  /** Web App button — opens the Mini App in Telegram. */
  web_app?: { url: string };
  /** Plain link — opens the URL in the user's default browser. */
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface SendMessageInput {
  chat_id: string | number;
  text: string;
  /** ParseMode — keep at MarkdownV2 with explicit escaping. */
  parse_mode?: 'MarkdownV2' | 'HTML' | undefined;
  reply_markup?: InlineKeyboardMarkup;
  disable_web_page_preview?: boolean;
}

export interface AnswerCallbackQueryInput {
  callback_query_id: string;
  text?: string;
  show_alert?: boolean;
}

export interface EditMessageReplyMarkupInput {
  chat_id: string | number;
  message_id: number;
  reply_markup: InlineKeyboardMarkup | undefined;
}

export interface TelegramApiError extends Error {
  description: string;
  errorCode: number;
}

export class TelegramApi {
  private readonly base: string;
  constructor(private readonly botToken: string) {
    this.base = `https://api.telegram.org/bot${this.botToken}`;
  }

  async sendMessage(input: SendMessageInput): Promise<void> {
    await this.call('sendMessage', input);
  }

  async answerCallbackQuery(input: AnswerCallbackQueryInput): Promise<void> {
    await this.call('answerCallbackQuery', input);
  }

  async editMessageReplyMarkup(input: EditMessageReplyMarkupInput): Promise<void> {
    await this.call('editMessageReplyMarkup', input);
  }

  /**
   * Set the webhook to the configured URL. Idempotent — Telegram returns
   * `ok=true` even if the webhook is already pointed at the same URL.
   */
  async setWebhook(opts: {
    url: string;
    secretToken: string;
    allowedUpdates: readonly string[];
  }): Promise<void> {
    await this.call('setWebhook', {
      url: opts.url,
      secret_token: opts.secretToken,
      allowed_updates: [...opts.allowedUpdates],
      drop_pending_updates: false,
    });
  }

  async deleteWebhook(): Promise<void> {
    await this.call('deleteWebhook', { drop_pending_updates: false });
  }

  async getMe(): Promise<{ id: number; username: string }> {
    const res = await this.call<{ id: number; username: string }>('getMe', {});
    return res;
  }

  /**
   * Register the bot's command menu (the `/` autocomplete + the Menu
   * button list). Idempotent — `setMyCommands` REPLACES the whole list,
   * so the caller passes the complete set every boot. Resolves on
   * success; throws `TelegramApiError` on a Bot-API failure.
   */
  async setMyCommands(
    commands: ReadonlyArray<{ command: string; description: string }>,
  ): Promise<void> {
    await this.call<boolean>('setMyCommands', { commands: [...commands] });
  }

  /**
   * Long-poll wrapper. Returns up to ~100 updates after `offset` with a
   * server-side wait of `timeoutSec` if no updates are pending. Used by
   * the dev long-poll mode in `index.ts`.
   */
  async getUpdates(opts: {
    offset: number;
    timeoutSec: number;
    allowedUpdates: readonly string[];
  }): Promise<unknown[]> {
    const res = await this.call<unknown[]>('getUpdates', {
      offset: opts.offset,
      timeout: opts.timeoutSec,
      allowed_updates: [...opts.allowedUpdates],
    });
    return Array.isArray(res) ? res : [];
  }

  private async call<T>(method: string, body: object): Promise<T> {
    const url = `${this.base}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch((networkErr) => {
      // M-7: Node's `fetch` errors stringify the URL into the message,
      // which embeds the bot token. Throw a sanitized error so logs
      // upstream cannot leak the secret.
      throw new Error(
        `telegram api ${method} network failure: ${
          networkErr instanceof Error ? networkErr.message.replace(this.botToken, '<redacted>') : 'unknown'
        }`,
      );
    });
    let parsed: { ok: boolean; result?: T; description?: string; error_code?: number };
    try {
      parsed = (await res.json()) as typeof parsed;
    } catch (e) {
      throw new Error(`telegram api ${method} returned non-JSON (${res.status})`);
    }
    if (!parsed.ok || parsed.result === undefined) {
      const err = new Error(
        `telegram api ${method} failed: ${parsed.description ?? '(no description)'}`,
      ) as TelegramApiError;
      err.description = parsed.description ?? '';
      err.errorCode = parsed.error_code ?? res.status;
      throw err;
    }
    return parsed.result;
  }
}

/**
 * Escape MarkdownV2 reserved characters per
 * https://core.telegram.org/bots/api#markdownv2-style — required because
 * an unescaped user-supplied string (e.g. an issuer label with a `.`)
 * causes Telegram to silently drop the message.
 */
const MD_V2_RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;
export function escapeMarkdownV2(s: string): string {
  return s.replace(MD_V2_RESERVED, (c) => `\\${c}`);
}
