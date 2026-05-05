import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const VALID_TOKEN = '111111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const VALID_SERVICE_SECRET = 'a'.repeat(32);
const VALID_WEBHOOK_SECRET = 'a'.repeat(32);

describe('loadConfig', () => {
  it('loads with all required fields', () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: VALID_TOKEN,
      TELEGRAM_BOT_USERNAME: 'muhaven_bot',
      TELEGRAM_BOT_SERVICE_SECRET: VALID_SERVICE_SECRET,
      TELEGRAM_WEBHOOK_SECRET_TOKEN: VALID_WEBHOOK_SECRET,
    });
    expect(config.botToken).toBe(VALID_TOKEN);
    expect(config.botUsername).toBe('muhaven_bot');
    expect(config.port).toBe(3004);
    expect(config.webhookUrl).toBeUndefined();
  });

  it('strips a leading @ from the bot username', () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: VALID_TOKEN,
      TELEGRAM_BOT_USERNAME: '@muhaven_bot',
      TELEGRAM_BOT_SERVICE_SECRET: VALID_SERVICE_SECRET,
      TELEGRAM_WEBHOOK_SECRET_TOKEN: VALID_WEBHOOK_SECRET,
    });
    expect(config.botUsername).toBe('muhaven_bot');
  });

  it('refuses to start when TELEGRAM_BOT_TOKEN is missing', () => {
    expect(() =>
      loadConfig({
        TELEGRAM_BOT_USERNAME: 'muhaven_bot',
        TELEGRAM_BOT_SERVICE_SECRET: VALID_SERVICE_SECRET,
        TELEGRAM_WEBHOOK_SECRET_TOKEN: VALID_WEBHOOK_SECRET,
      }),
    ).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('refuses to start when TELEGRAM_BOT_TOKEN has the wrong shape', () => {
    expect(() =>
      loadConfig({
        TELEGRAM_BOT_TOKEN: 'definitely-not-a-bot-token',
        TELEGRAM_BOT_USERNAME: 'muhaven_bot',
        TELEGRAM_BOT_SERVICE_SECRET: VALID_SERVICE_SECRET,
        TELEGRAM_WEBHOOK_SECRET_TOKEN: VALID_WEBHOOK_SECRET,
      }),
    ).toThrow(/expected shape/);
  });

  it('refuses to start when SERVICE_SECRET is too short', () => {
    expect(() =>
      loadConfig({
        TELEGRAM_BOT_TOKEN: VALID_TOKEN,
        TELEGRAM_BOT_USERNAME: 'muhaven_bot',
        TELEGRAM_BOT_SERVICE_SECRET: 'short',
        TELEGRAM_WEBHOOK_SECRET_TOKEN: VALID_WEBHOOK_SECRET,
      }),
    ).toThrow(/SERVICE_SECRET/);
  });

  it('refuses to start when WEBHOOK_SECRET is too short', () => {
    expect(() =>
      loadConfig({
        TELEGRAM_BOT_TOKEN: VALID_TOKEN,
        TELEGRAM_BOT_USERNAME: 'muhaven_bot',
        TELEGRAM_BOT_SERVICE_SECRET: VALID_SERVICE_SECRET,
        TELEGRAM_WEBHOOK_SECRET_TOKEN: 'short',
      }),
    ).toThrow(/WEBHOOK_SECRET/);
  });

  it('honors TELEGRAM_WEBHOOK_URL when set', () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: VALID_TOKEN,
      TELEGRAM_BOT_USERNAME: 'muhaven_bot',
      TELEGRAM_BOT_SERVICE_SECRET: VALID_SERVICE_SECRET,
      TELEGRAM_WEBHOOK_SECRET_TOKEN: VALID_WEBHOOK_SECRET,
      TELEGRAM_WEBHOOK_URL: 'https://nagreg.hasto.dev/telegram-bot/webhook',
    });
    expect(config.webhookUrl).toBe('https://nagreg.hasto.dev/telegram-bot/webhook');
  });
});
