import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  BotHandler,
  encodeCallbackData,
  parseCallbackData,
  type TelegramUpdate,
} from '../src/bot.js';
import { BackendClient, BackendClientError } from '../src/backend-client.js';

// ── Stub backend client ──────────────────────────────────────────────

function stubBackend(): BackendClient {
  const stub = new BackendClient({
    baseUrl: 'http://test',
    serviceSecret: 'test-secret-32-chars-min-pad-pad-pad',
    timeoutMs: 100,
  });
  // Replace methods with vi.fn().
  stub.consumeLinkCode = vi
    .fn()
    .mockResolvedValue({
      link: {
        telegramChatId: '12345',
        userId: 'u1abcdef',
        linkedAt: '2026-04-30T00:00:00Z',
      },
    }) as typeof stub.consumeLinkCode;
  stub.confirmIntent = vi
    .fn()
    .mockResolvedValue({
      intent: {
        intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'buy',
        tier: 'inline',
        status: 'confirmed',
        amountUsd6: '50000000',
        intentHash: 'a'.repeat(64),
        expiresAt: '2026-04-30T00:05:00Z',
      },
    }) as typeof stub.confirmIntent;
  stub.denyIntent = vi.fn().mockResolvedValue({
    intent: { intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA', status: 'denied' },
  }) as typeof stub.denyIntent;
  return stub;
}

function buildHandler(backend: BackendClient): BotHandler {
  return new BotHandler({
    backend,
    botUsername: 'muhaven_bot',
    miniAppUrl: 'https://muhaven.hasto.dev/telegram-mini-app',
    dashboardUrl: 'https://muhaven.hasto.dev',
  });
}

// ── parseCallbackData ────────────────────────────────────────────────

describe('parseCallbackData', () => {
  it('parses cnf:<intentId>', () => {
    const r = parseCallbackData('cnf:oci_AAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(r).toEqual({ kind: 'cnf', intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA' });
  });

  it('parses dny:<intentId>', () => {
    const r = parseCallbackData('dny:oci_AAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(r).toEqual({ kind: 'dny', intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA' });
  });

  it('rejects garbage', () => {
    expect(parseCallbackData('garbage')).toBeNull();
    expect(parseCallbackData(undefined)).toBeNull();
    expect(parseCallbackData('cnf:not_an_intent')).toBeNull();
  });

  it('round-trips encode/parse', () => {
    const data = { kind: 'cnf' as const, intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA' };
    expect(parseCallbackData(encodeCallbackData(data))).toEqual(data);
  });
});

// ── /start <linkCode> handling ──────────────────────────────────────

describe('BotHandler — /start command', () => {
  let backend: BackendClient;
  let handler: BotHandler;

  beforeEach(() => {
    backend = stubBackend();
    handler = buildHandler(backend);
  });

  it('rejects /start without a code with a guidance message', async () => {
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 12345, type: 'private' },
        text: '/start',
      },
    };
    const effects = await handler.handleUpdate(update);
    expect(effects.length).toBe(1);
    expect(effects[0]!.kind).toBe('send');
  });

  it('forwards /start <code> to the backend with chat-id + user-id + username', async () => {
    const update: TelegramUpdate = {
      update_id: 2,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 12345, type: 'private' },
        from: { id: 12345, is_bot: false, first_name: 'Alice', username: 'alice' },
        text: '/start ABCD1234',
      },
    };
    const effects = await handler.handleUpdate(update);
    expect(backend.consumeLinkCode).toHaveBeenCalledWith({
      linkCode: 'ABCD1234',
      telegramChatId: '12345',
      telegramUserId: '12345',
      telegramUsername: 'alice',
    });
    expect(effects.length).toBe(1);
    expect(effects[0]!.kind).toBe('send');
  });

  it('refuses /start <code> when message.from is absent (malformed update)', async () => {
    const update: TelegramUpdate = {
      update_id: 2,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 12345, type: 'private' },
        // from omitted
        text: '/start ABCD1234',
      },
    };
    const effects = await handler.handleUpdate(update);
    expect(backend.consumeLinkCode).not.toHaveBeenCalled();
    expect(effects.length).toBe(1);
  });

  it('rejects malformed link codes locally without hitting backend', async () => {
    const update: TelegramUpdate = {
      update_id: 3,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 12345, type: 'private' },
        text: '/start malformed',
      },
    };
    const effects = await handler.handleUpdate(update);
    expect(backend.consumeLinkCode).not.toHaveBeenCalled();
    expect(effects.length).toBe(1);
  });
});

// ── Group-chat refusal ───────────────────────────────────────────────

describe('BotHandler — refuses group chats', () => {
  it('returns a polite refusal in a group context', async () => {
    const handler = buildHandler(stubBackend());
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: -100123, type: 'supergroup', title: 'crypto chat' },
        text: '/help',
      },
    };
    const effects = await handler.handleUpdate(update);
    expect(effects.length).toBe(1);
    expect(effects[0]!.kind).toBe('send');
  });
});

// ── Free-form text refusal ───────────────────────────────────────────

describe('BotHandler — free-form text', () => {
  it('refuses to act on free-form text — no LLM here', async () => {
    const handler = buildHandler(stubBackend());
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 12345, type: 'private' },
        text: 'buy me some TBILL please',
      },
    };
    const effects = await handler.handleUpdate(update);
    expect(effects.length).toBe(1);
    expect(effects[0]!.kind).toBe('send');
  });
});

// ── Inline-tier callback handling ────────────────────────────────────

describe('BotHandler — inline confirm callback', () => {
  let backend: BackendClient;
  let handler: BotHandler;

  beforeEach(() => {
    backend = stubBackend();
    handler = buildHandler(backend);
  });

  it('confirms an intent on cnf:<intentId> callback (sends chat-id + user-id)', async () => {
    const update: TelegramUpdate = {
      update_id: 1,
      callback_query: {
        id: 'cb1',
        from: { id: 12345, is_bot: false, first_name: 'Alice' },
        message: {
          message_id: 99,
          date: 0,
          chat: { id: 12345, type: 'private' },
        },
        data: 'cnf:oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
        chat_instance: '0',
      },
    };
    const effects = await handler.handleUpdate(update);
    expect(backend.confirmIntent).toHaveBeenCalledWith({
      intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
      expectedChatId: '12345',
      expectedUserId: '12345',
      source: 'telegram_inline',
    });
    // Expect: answer_callback + edit_markup + send_text
    const kinds = effects.map((e) => e.kind);
    expect(kinds).toContain('answer_callback');
    expect(kinds).toContain('edit_markup');
    expect(kinds).toContain('send');
  });

  it('denies an intent on dny:<intentId> callback (sends chat-id + user-id)', async () => {
    const update: TelegramUpdate = {
      update_id: 1,
      callback_query: {
        id: 'cb2',
        from: { id: 12345, is_bot: false, first_name: 'Alice' },
        message: { message_id: 99, date: 0, chat: { id: 12345, type: 'private' } },
        data: 'dny:oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
        chat_instance: '0',
      },
    };
    const effects = await handler.handleUpdate(update);
    expect(backend.denyIntent).toHaveBeenCalledWith({
      intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
      expectedChatId: '12345',
      expectedUserId: '12345',
      reason: 'user_denied',
    });
    expect(effects.find((e) => e.kind === 'send')).toBeDefined();
  });

  it('refuses callback when chat.type is not private (M-2)', async () => {
    const update: TelegramUpdate = {
      update_id: 1,
      callback_query: {
        id: 'cb-group',
        from: { id: 12345, is_bot: false, first_name: 'Alice' },
        message: {
          message_id: 99,
          date: 0,
          chat: { id: -100123, type: 'supergroup', title: 'crypto chat' },
        },
        data: 'cnf:oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
        chat_instance: '0',
      },
    };
    const effects = await handler.handleUpdate(update);
    expect(backend.confirmIntent).not.toHaveBeenCalled();
    expect(effects.length).toBe(1);
    expect(effects[0]!.kind).toBe('answer_callback');
  });

  it('refuses callback when from.id ≠ chat.id (M-2)', async () => {
    const update: TelegramUpdate = {
      update_id: 1,
      callback_query: {
        id: 'cb-spoof',
        from: { id: 67890, is_bot: false, first_name: 'Eve' },
        message: { message_id: 99, date: 0, chat: { id: 12345, type: 'private' } },
        data: 'cnf:oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
        chat_instance: '0',
      },
    };
    const effects = await handler.handleUpdate(update);
    expect(backend.confirmIntent).not.toHaveBeenCalled();
    expect(effects.length).toBe(1);
    expect(effects[0]!.kind).toBe('answer_callback');
  });

  it('shows an alert when backend returns 410 Gone (intent expired)', async () => {
    backend.confirmIntent = vi
      .fn()
      .mockRejectedValue(new BackendClientError(410, 'expired'));
    const update: TelegramUpdate = {
      update_id: 1,
      callback_query: {
        id: 'cb3',
        from: { id: 12345, is_bot: false, first_name: 'Alice' },
        message: { message_id: 99, date: 0, chat: { id: 12345, type: 'private' } },
        data: 'cnf:oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
        chat_instance: '0',
      },
    };
    const effects = await handler.handleUpdate(update);
    const alert = effects.find((e) => e.kind === 'answer_callback');
    expect(alert).toBeDefined();
    expect(alert?.kind).toBe('answer_callback');
    if (alert?.kind === 'answer_callback') {
      expect(alert.payload.show_alert).toBe(true);
      expect(alert.payload.text?.toLowerCase()).toContain('expired');
    }
  });

  it('drops unrecognized callback data with a polite alert', async () => {
    const update: TelegramUpdate = {
      update_id: 1,
      callback_query: {
        id: 'cb4',
        from: { id: 12345, is_bot: false, first_name: 'Alice' },
        message: { message_id: 99, date: 0, chat: { id: 12345, type: 'private' } },
        data: 'garbage',
        chat_instance: '0',
      },
    };
    const effects = await handler.handleUpdate(update);
    expect(backend.confirmIntent).not.toHaveBeenCalled();
    expect(backend.denyIntent).not.toHaveBeenCalled();
    expect(effects.some((e) => e.kind === 'answer_callback')).toBe(true);
  });
});

// ── Intent keyboard rendering ────────────────────────────────────────

describe('BotHandler.buildIntentKeyboard', () => {
  const handler = new BotHandler({
    backend: stubBackend(),
    botUsername: 'muhaven_bot',
    miniAppUrl: 'https://muhaven.hasto.dev/telegram-mini-app',
    dashboardUrl: 'https://muhaven.hasto.dev',
  });

  it('renders inline tier with Confirm + Deny buttons', () => {
    const kb = handler.buildIntentKeyboard({ intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA', tier: 'inline' });
    expect(kb.inline_keyboard.length).toBe(1);
    expect(kb.inline_keyboard[0]!.length).toBe(2);
    expect(kb.inline_keyboard[0]![0]!.callback_data).toBe(
      'cnf:oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
  });

  it('renders mini-app tier with web_app button + Deny callback', () => {
    const kb = handler.buildIntentKeyboard({ intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA', tier: 'mini_app_otp' });
    const flat = kb.inline_keyboard.flat();
    expect(flat.find((b) => b.web_app)?.web_app?.url).toContain(
      'https://muhaven.hasto.dev/telegram-mini-app?intent=oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(flat.find((b) => b.callback_data?.startsWith('dny:'))).toBeDefined();
  });

  it('renders passkey-deeplink tier with a dashboard URL button', () => {
    const kb = handler.buildIntentKeyboard({
      intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
      tier: 'passkey_deeplink',
    });
    const flat = kb.inline_keyboard.flat();
    expect(flat.find((b) => b.url)?.url).toContain(
      '/agent/confirm?intent=oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(flat.find((b) => b.url)?.url).toContain('from=telegram');
  });
});
