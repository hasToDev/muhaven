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
  /** Public URL Telegram POSTs updates to (e.g. https://nagreg.hasto.dev/telegram-bot/webhook).
   *  When unset, the worker uses long-polling (dev/local). */
  webhookUrl?: string | undefined;
  /** Public Mini App URL for the inline keyboard `web_app` button. */
  miniAppUrl: string;
  /** Public dashboard URL for the >$5K passkey deep-link. */
  dashboardUrl: string;
  /** HTTP port the bot worker listens on (webhook + health). */
  port: number;
}

const DEFAULT_BACKEND_URL = 'http://backend:3000';
const DEFAULT_DASHBOARD_URL = 'https://muhaven.hasto.dev';
const DEFAULT_MINI_APP_URL = 'https://muhaven.hasto.dev/telegram-mini-app';
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
  };
}
