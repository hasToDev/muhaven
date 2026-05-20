/**
 * Telegram bot worker configuration. Validated at boot — missing
 * required fields fail-fast rather than silently disabling features.
 */

export interface TelegramBotConfig {
  /** Telegram Bot API token (from @BotFather). REQUIRED. */
  botToken: string;
  /** Bot username without `@` (e.g. `muhaven_bot`). REQUIRED for deep-links. */
  botUsername: string;
  /** Backend base URL for the OpenClaw intent endpoints. */
  backendBaseUrl: string;
  /** Service-to-service secret presented to the backend. REQUIRED. */
  backendServiceSecret: string;
  /** Webhook secret token Telegram echoes on every update. REQUIRED. */
  webhookSecretToken: string;
  /** Public URL Telegram POSTs updates to (e.g. https://tg.muhaven.app/webhook).
   *  When unset, the worker uses long-polling (dev/local). */
  webhookUrl?: string | undefined;
  /** Public Mini App URL for the inline keyboard `web_app` button. */
  miniAppUrl: string;
  /** Public dashboard URL for the >$5K passkey deep-link. */
  dashboardUrl: string;
  /** HTTP port the bot worker listens on (webhook + health). */
  port: number;
  /** Wave 4 P7 — Telegram channel id (numeric, e.g. `-1001234567890`)
   *  the worker posts issuer-narrative events to (distribution-funded,
   *  KYC-changed, token-unpaused). Operator setup deferred to the
   *  grant-submission window (see PROGRESS.md §"P4 operator tasks").
   *  When unset the broadcast endpoint logs + drops. */
  issuerChannelId?: string | undefined;
  /** Wave 5 Q3 — chat id the `/operator/alert` endpoint is allowed to
   *  forward to. Pinned server-side per round-1 Security H-3: if the
   *  shared `TELEGRAM_BOT_SERVICE_SECRET` leaks, an attacker with the
   *  secret can still only post alerts into THIS chat — not arbitrary
   *  chats the bot has joined. Backend `OPERATOR_TELEGRAM_CHAT_ID`
   *  must equal this value. When unset, the endpoint logs + drops
   *  (operator setup deferred, same posture as `issuerChannelId`). */
  operatorChatId?: string | undefined;
}

const DEFAULT_BACKEND_URL = 'http://backend:3000';
const DEFAULT_DASHBOARD_URL = 'https://muhaven.app';
const DEFAULT_MINI_APP_URL = 'https://muhaven.app/telegram-mini-app';
const DEFAULT_PORT = 3004;

function trimSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function readRequired(name: string, env: NodeJS.ProcessEnv): string {
  const v = env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(
      `[telegram-bot] required env ${name} is missing — refusing to start`,
    );
  }
  return v.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TelegramBotConfig {
  const botToken = readRequired('TELEGRAM_BOT_TOKEN', env);
  if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
    throw new Error(
      `[telegram-bot] TELEGRAM_BOT_TOKEN does not match the expected shape (numeric_id:base64url_secret). Re-issue via @BotFather.`,
    );
  }
  const botUsername = readRequired('TELEGRAM_BOT_USERNAME', env).replace(/^@/, '');
  const backendBaseUrl = trimSlash(env.TELEGRAM_BOT_BACKEND_URL ?? DEFAULT_BACKEND_URL);
  const backendServiceSecret = readRequired('TELEGRAM_BOT_SERVICE_SECRET', env);
  if (backendServiceSecret.length < 32) {
    throw new Error(
      `[telegram-bot] TELEGRAM_BOT_SERVICE_SECRET must be ≥32 chars (got ${backendServiceSecret.length})`,
    );
  }
  const webhookSecretToken = readRequired('TELEGRAM_WEBHOOK_SECRET_TOKEN', env);
  if (webhookSecretToken.length < 16) {
    throw new Error(
      `[telegram-bot] TELEGRAM_WEBHOOK_SECRET_TOKEN must be ≥16 chars (got ${webhookSecretToken.length})`,
    );
  }
  const webhookUrl = env.TELEGRAM_WEBHOOK_URL?.trim() || undefined;
  const miniAppUrl = trimSlash(env.TELEGRAM_MINI_APP_URL ?? DEFAULT_MINI_APP_URL);
  const dashboardUrl = trimSlash(env.MUHAVEN_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL);
  const port = Number.parseInt(env.PORT ?? String(DEFAULT_PORT), 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`[telegram-bot] PORT must be a positive integer (got "${env.PORT}")`);
  }
  // Wave 4 P7 — issuer channel (informative; broadcast is no-op when unset).
  const issuerChannelId = env.TELEGRAM_ISSUER_CHANNEL_ID?.trim() || undefined;
  if (issuerChannelId !== undefined && !/^-?\d{5,}$/.test(issuerChannelId)) {
    throw new Error(
      `[telegram-bot] TELEGRAM_ISSUER_CHANNEL_ID must be a Telegram chat-id integer (e.g. -1001234567890). Got "${issuerChannelId}".`,
    );
  }
  // Wave 5 Q3 — operator-alert chat pin (Security H-3 + Round-2 API
  // H-1). Reject leading zeros so the constant-time lexical compare at
  // request time matches Telegram's numeric identity of the chat
  // ('00012345' === 12345 numerically; with the looser regex an
  // operator who pasted leading zeros into one var but not the other
  // would silently 403 every alert).
  const operatorChatId = env.OPERATOR_TELEGRAM_CHAT_ID?.trim() || undefined;
  if (operatorChatId !== undefined && !/^-?(?:0|[1-9]\d{0,31})$/.test(operatorChatId)) {
    throw new Error(
      `[telegram-bot] OPERATOR_TELEGRAM_CHAT_ID must be a Telegram chat-id integer with no leading zeros (e.g. 12345 or -1001234567890). Got "${operatorChatId}".`,
    );
  }
  return {
    botToken,
    botUsername,
    backendBaseUrl,
    backendServiceSecret,
    webhookSecretToken,
    webhookUrl,
    miniAppUrl,
    dashboardUrl,
    port,
    issuerChannelId,
    operatorChatId,
  };
}
