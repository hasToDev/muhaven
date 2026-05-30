/**
 * MuHaven Telegram bot worker — Express HTTP server.
 *
 * Two modes:
 *   - **Webhook** (production): Telegram POSTs updates to
 *     `${TELEGRAM_WEBHOOK_URL}` with a fixed
 *     `X-Telegram-Bot-Api-Secret-Token` header. The worker verifies the
 *     header constant-time, parses the update, dispatches to BotHandler,
 *     and applies the side-effects through TelegramApi.
 *   - **Long-poll** (dev): when `TELEGRAM_WEBHOOK_URL` is unset the
 *     worker polls `getUpdates` in a loop. Useful for local development
 *     where Telegram cannot reach the host.
 *
 * Health endpoint at `GET /health` returns `{ status: 'ok' }` for the
 * Docker / Cloudflare tunnel health probes.
 */

import express, { type Request, type Response } from 'express';
import { loadConfig } from './config.js';
import { TelegramApi } from './telegram-api.js';
import { BackendClient } from './backend-client.js';
import { BotHandler, type BotEffect, type TelegramUpdate } from './bot.js';
import {
  renderIntentPreview,
  renderOtpMessage,
  validateIntentNotificationBody,
  type IntentNotificationBody,
} from './intent-notify.js';
import {
  renderOperatorAlert,
  validateOperatorAlertBody,
  type OperatorAlertBody,
} from './operator-alert.js';

const ALLOWED_UPDATES = ['message', 'callback_query'] as const;

async function main(): Promise<void> {
  const config = loadConfig();
  const api = new TelegramApi(config.botToken);
  const backend = new BackendClient({
    baseUrl: config.backendBaseUrl,
    serviceSecret: config.backendServiceSecret,
  });
  const handler = new BotHandler({
    backend,
    botUsername: config.botUsername,
    miniAppUrl: config.miniAppUrl,
    dashboardUrl: config.dashboardUrl,
  });

  // Verify the bot token resolves before binding the webhook — fails
  // fast on a typo in TELEGRAM_BOT_TOKEN.
  try {
    const me = await api.getMe();
    if (me.username && me.username.toLowerCase() !== config.botUsername.toLowerCase()) {
      // eslint-disable-next-line no-console
      console.warn(
        `[telegram-bot] config TELEGRAM_BOT_USERNAME (${config.botUsername}) does not match the BotFather username (${me.username}). Continuing — username is informational only.`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`[telegram-bot] authenticated as @${me.username} (id=${me.id})`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[telegram-bot] getMe failed:', err);
    process.exit(1);
  }

  // Register the slash-command menu (the `/` autocomplete + Menu button).
  // `setMyCommands` REPLACES the whole list, so we pass the complete set.
  // Non-fatal: a transient Bot-API hiccup here must not crash boot — the
  // commands still work without the menu (the handler dispatches on the
  // raw text), the menu is purely discoverability sugar.
  try {
    await api.setMyCommands([
      { command: 'help', description: 'Show available commands' },
      { command: 'pause', description: 'How to pause your agent' },
      {
        command: 'revoke_session',
        description: 'Revoke autonomous session (kill-switch)',
      },
      { command: 'unlink', description: 'How to unlink Telegram' },
    ]);
    // eslint-disable-next-line no-console
    console.log('[telegram-bot] command menu registered');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[telegram-bot] setMyCommands failed (non-fatal):', err);
  }

  const app = express();
  app.use(express.json({ limit: '256kb' }));
  // Round-2 API-Tester M-1 — Express's default body-parser error for
  // oversize bodies returns an HTML 413 page; every other 4xx on this
  // worker returns `{error: '...'}`. Normalise here so the
  // backend transport's `!res.ok` log path stays JSON-parseable and
  // so cURL output is consistent for the operator.
  app.use((err: Error & { type?: string }, req: Request, res: Response, next: (err?: unknown) => void) => {
    if (err && err.type === 'entity.too.large') {
      res.status(413).json({ error: 'body too large' });
      return;
    }
    next(err);
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', mode: config.webhookUrl ? 'webhook' : 'long-poll' });
  });

  // Wave 4 P7 — issuer-channel broadcast endpoint. The backend POSTs
  // sanitised issuer-narrative events here (distribution-funded /
  // kyc-added / kyc-removed / token-unpaused). Authenticated by the
  // existing `TELEGRAM_BOT_SERVICE_SECRET` shared between the dashboard
  // → bot path and the bot → backend path. When the operator hasn't
  // provisioned `TELEGRAM_ISSUER_CHANNEL_ID` the endpoint accepts the
  // event but logs + drops it (operator-deferred).
  app.post('/issuer-channel/broadcast', async (req: Request, res: Response) => {
    const supplied = req.header('x-muhaven-service-secret') ?? '';
    if (
      supplied.length !== config.backendServiceSecret.length ||
      !constantTimeEqual(supplied, config.backendServiceSecret)
    ) {
      res.status(401).json({ error: 'invalid service secret' });
      return;
    }
    const body = req.body as {
      eventType?: string;
      tokenSymbol?: string;
      issuerLabel?: string;
      summary?: string;
      txHash?: string | null;
      distributionId?: number | null;
      totalUsd6?: string | null;
    } | null;
    if (!body || typeof body !== 'object' || typeof body.eventType !== 'string') {
      res.status(400).json({ error: 'malformed event payload' });
      return;
    }

    if (!config.issuerChannelId) {
      // eslint-disable-next-line no-console
      console.info(
        `[telegram-bot] issuer-channel broadcast received but TELEGRAM_ISSUER_CHANNEL_ID is unset — event ${body.eventType} for ${body.tokenSymbol} dropped`,
      );
      res.status(202).json({ status: 'logged', dispatched: false });
      return;
    }

    const text = renderIssuerChannelMessage(body);
    try {
      await api.sendMessage({
        chat_id: config.issuerChannelId,
        text,
        parse_mode: 'MarkdownV2',
      });
      res.status(200).json({ status: 'sent' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[telegram-bot] issuer-channel send failed:', err);
      // 200 — failures here MUST NOT block the agent's commit path.
      res.status(200).json({ status: 'send-failed' });
    }
  });

  // Wave 5 Q3 step 3 — backend → bot operator-alert push. The backend's
  // YieldDistributionCron (and any future operator-alert producer) posts
  // a `{chatId, severity, message}` payload here when an unattended
  // pipeline trips an alertable condition. Authenticated by the same
  // `TELEGRAM_BOT_SERVICE_SECRET` shared with the other service-secret
  // endpoints above. The renderer escapes MarkdownV2 + prepends a
  // severity emoji; failures are 200 (operator alerts are
  // best-effort — a worker outage MUST NOT crash-loop the producer).
  app.post('/operator/alert', async (req: Request, res: Response) => {
    const supplied = req.header('x-muhaven-service-secret') ?? '';
    if (
      supplied.length !== config.backendServiceSecret.length ||
      !constantTimeEqual(supplied, config.backendServiceSecret)
    ) {
      res.status(401).json({ error: 'invalid service secret' });
      return;
    }
    const validation = validateOperatorAlertBody(req.body as OperatorAlertBody | null);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const alert = validation.value;
    // Round-1 Security H-3 — chat-id pin. If the operator has wired
    // `OPERATOR_TELEGRAM_CHAT_ID` on the bot side, refuse to forward to
    // any other chat even when the service-secret check passes. This
    // blunts a service-secret leak so an attacker cannot spam alerts
    // into arbitrary chats the bot has joined (operator harassment,
    // social-engineering primitive). Constant-time compare matches the
    // posture on the secret check above.
    if (config.operatorChatId) {
      if (
        alert.chatId.length !== config.operatorChatId.length ||
        !constantTimeEqual(alert.chatId, config.operatorChatId)
      ) {
        // eslint-disable-next-line no-console
        console.warn(
          `[telegram-bot] operator-alert refused: chatId="${alert.chatId}" does not match configured OPERATOR_TELEGRAM_CHAT_ID`,
        );
        res.status(403).json({ error: 'chat-id not allowed' });
        return;
      }
    } else {
      // No operator chat configured — log + 202 (matches
      // `/issuer-channel/broadcast` posture for unset `issuerChannelId`).
      // eslint-disable-next-line no-console
      console.info(
        `[telegram-bot] operator-alert received but OPERATOR_TELEGRAM_CHAT_ID is unset — event dropped (severity=${alert.severity})`,
      );
      res.status(202).json({ status: 'logged', dispatched: false });
      return;
    }
    const text = renderOperatorAlert(alert);
    try {
      await api.sendMessage({
        chat_id: alert.chatId,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      });
      res.status(200).json({ status: 'sent' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[telegram-bot] operator-alert send failed:', err);
      // 200 — same posture as `/intent/notify` and
      // `/issuer-channel/broadcast`. Operator alerts are advisory; a
      // bot-side bug MUST NOT block whatever upstream producer
      // triggered the alert (the cron's tick handler swallows transport
      // errors and continues).
      res.status(200).json({ status: 'send-failed' });
    }
  });

  // Wave 4 P4 — backend → bot intent push. The backend mints an
  // OpenClawIntent (parallel to the dashboard ConfirmModal flow) and
  // POSTs the cleartext preview here whenever the user has linked
  // Telegram. Authenticated by the same `TELEGRAM_BOT_SERVICE_SECRET`
  // already shared on the bot → backend service-secret path; constant-
  // time compared on every request.
  //
  // Privacy posture: the payload here is what the user already saw the
  // LLM emit at propose time (token, summary, amount). The bot worker
  // does NOT see the user's JWT; the inline-tier confirm callback flows
  // back through `/api/v1/agent/openclaw/intent/confirm-inline` (which
  // re-authenticates the chat via `telegram_links`).
  //
  // Failures are 200 — a worker-side bug MUST NOT make the backend's
  // propose path retry; the dashboard ConfirmModal stays the canonical
  // surface. The 5xx return shape is reserved for actual auth failures
  // (401 service-secret mismatch / 400 malformed payload).
  app.post('/intent/notify', async (req: Request, res: Response) => {
    const supplied = req.header('x-muhaven-service-secret') ?? '';
    if (
      supplied.length !== config.backendServiceSecret.length ||
      !constantTimeEqual(supplied, config.backendServiceSecret)
    ) {
      res.status(401).json({ error: 'invalid service secret' });
      return;
    }
    const body = req.body as IntentNotificationBody | null;
    const validation = validateIntentNotificationBody(body);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const { intent, telegramChatId, otp } = validation.value;
    const tier = intent.tier;
    const keyboard = handler.buildIntentKeyboard({
      intentId: intent.intentId,
      tier,
    });
    const previewText = renderIntentPreview(intent);
    try {
      await api.sendMessage({
        chat_id: telegramChatId,
        text: previewText,
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard,
        disable_web_page_preview: true,
      });
      // Mid-tier ($200–$5K): deliver the OTP in a SEPARATE message so
      // it lives in a different bubble from the Mini App button. The
      // user copies the digits from this message into the Mini App
      // OTP field; the backend HMAC-verifies + matches at confirm time.
      // The OTP MUST NOT share the bubble with the web_app button —
      // the Mini App's clientside has no JS access to the surrounding
      // chat thread, so the OTP can't auto-fill (intentional).
      if (tier === 'mini_app_otp' && otp) {
        await api.sendMessage({
          chat_id: telegramChatId,
          text: renderOtpMessage(otp),
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        });
      }
      res.status(200).json({ status: 'sent' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[telegram-bot] intent notify send failed:', err);
      // 200 — same posture as /issuer-channel/broadcast: failures must
      // not block the agent's commit path. The audit log already
      // recorded the propose; Telegram delivery is best-effort.
      res.status(200).json({ status: 'send-failed' });
    }
  });

  app.post('/webhook', async (req: Request, res: Response) => {
    const supplied = req.header('X-Telegram-Bot-Api-Secret-Token') ?? '';
    if (
      supplied.length !== config.webhookSecretToken.length ||
      !constantTimeEqual(supplied, config.webhookSecretToken)
    ) {
      res.status(401).json({ error: 'invalid webhook secret' });
      return;
    }
    let update: TelegramUpdate;
    try {
      update = req.body as TelegramUpdate;
    } catch {
      res.status(400).json({ error: 'malformed update' });
      return;
    }
    // Always 200 OK back to Telegram — they retry on non-2xx and we
    // don't want a bot-side bug to cause Telegram to hammer the
    // webhook. Side-effects below run async; failures log but don't
    // re-trigger Telegram retries.
    res.status(200).end();
    try {
      const effects = await handler.handleUpdate(update);
      await applyEffects(api, effects);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[telegram-bot] dispatch error:', err);
    }
  });

  if (config.webhookUrl) {
    await api.setWebhook({
      url: config.webhookUrl,
      secretToken: config.webhookSecretToken,
      allowedUpdates: ALLOWED_UPDATES,
    });
    // eslint-disable-next-line no-console
    console.log(`[telegram-bot] webhook registered at ${config.webhookUrl}`);
  } else {
    // eslint-disable-next-line no-console
    console.log('[telegram-bot] no webhook URL — long-poll mode');
    void runLongPoll(api, handler);
  }

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[telegram-bot] listening on :${config.port}`);
  });
}

async function applyEffects(api: TelegramApi, effects: readonly BotEffect[]): Promise<void> {
  for (const effect of effects) {
    try {
      switch (effect.kind) {
        case 'send':
          await api.sendMessage(effect.payload);
          break;
        case 'answer_callback':
          await api.answerCallbackQuery(effect.payload);
          break;
        case 'edit_markup':
          await api.editMessageReplyMarkup(effect.payload);
          break;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[telegram-bot] effect failed:', effect.kind, err);
    }
  }
}

async function runLongPoll(api: TelegramApi, handler: BotHandler): Promise<void> {
  // Minimal long-poll loop for dev. Production uses webhooks.
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const updates = (await api.getUpdates({
        offset,
        timeoutSec: 30,
        allowedUpdates: ALLOWED_UPDATES,
      })) as TelegramUpdate[];
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          const effects = await handler.handleUpdate(update);
          await applyEffects(api, effects);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[telegram-bot] long-poll dispatch error:', err);
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[telegram-bot] getUpdates failed:', err);
      await sleep(5000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Compose a MarkdownV2 message for the issuer-narrative channel. Every
 * dynamic substring is escaped per Bot API rules (`_*[]()~``>#+-=|{}.!`).
 *
 * Wave 4 P7 ships four event families: `distribution_funded` /
 * `kyc_added` / `kyc_removed` / `token_unpaused`. Unknown events emit a
 * generic "MuHaven event" line so a future event family doesn't silently
 * disappear; the bot stays forward-compatible with any new shape the
 * backend rolls out.
 */
function renderIssuerChannelMessage(ev: {
  eventType?: string;
  tokenSymbol?: string;
  issuerLabel?: string;
  summary?: string;
  txHash?: string | null;
  distributionId?: number | null;
  totalUsd6?: string | null;
}): string {
  const esc = (s: string): string =>
    s.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, (c) => '\\' + c);
  const symbol = esc(ev.tokenSymbol ?? '<?>');
  const issuer = esc(ev.issuerLabel ?? 'MuHaven Issuer');
  let title: string;
  switch (ev.eventType) {
    case 'distribution_funded':
      title = `*Yield distributed* — ${symbol}`;
      break;
    case 'kyc_added':
      title = `*KYC added* — ${symbol}`;
      break;
    case 'kyc_removed':
      title = `*KYC removed* — ${symbol}`;
      break;
    case 'token_unpaused':
      title = `*Token activated* — ${symbol}`;
      break;
    default:
      title = `*MuHaven event* — ${symbol}`;
  }
  const lines: string[] = [title, `_Issuer: ${issuer}_`];
  if (ev.summary) lines.push(esc(ev.summary));
  if (ev.distributionId != null) lines.push(`Distribution \\#${esc(String(ev.distributionId))}`);
  if (ev.totalUsd6 != null) {
    const v = BigInt(ev.totalUsd6);
    const whole = (v / 1_000_000n).toString();
    const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    const display = frac ? `$${whole}\\.${frac}` : `$${whole}`;
    lines.push(`Total: ${display}`);
  }
  if (ev.txHash) {
    const hex = ev.txHash.replace(/[^0-9a-fA-Fx]/g, '');
    lines.push(`Tx: \`${esc(hex)}\``);
  }
  return lines.join('\n');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[telegram-bot] fatal:', err);
  process.exit(1);
});
