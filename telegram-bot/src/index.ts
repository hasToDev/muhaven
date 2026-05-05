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

  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', mode: config.webhookUrl ? 'webhook' : 'long-poll' });
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
