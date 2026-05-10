import { describe, expect, it, beforeEach, beforeAll, vi } from 'vitest';
import {
  BotIntentNotificationSchema,
  HttpBotIntentTransport,
  LoggingBotIntentTransport,
  MintAndDeliverOpenClawIntentUseCase,
  type BotIntentNotification,
  type IBotIntentTransport,
} from '../notify-intent-to-bot.use-case.js';
import { CreateOpenClawIntentUseCase } from '../create-intent.use-case.js';
import { MemoryOpenClawIntentRepository } from '../../../../../infrastructure/repository/memory/index.js';
import { MemoryTelegramLinkRepository } from '../../../../../infrastructure/repository/memory/index.js';
import {
  OpenClawIntentKind,
  OpenClawIntentTier,
} from '../../../../../domain/agent/model/openclaw-intent.js';
import { TelegramLink } from '../../../../../domain/agent/model/telegram-link.js';

const NOW = new Date('2026-05-10T00:00:00.000Z');
const TOKEN = '0x1111111111111111111111111111111111111111' as const;

// Setup minimal env so getLogger() (memoized in core/logger.ts) can resolve
// LOG_LEVEL from the EnvSchema. The transport-throws + link-repo-throws
// tests below trigger lg().warn(...) on the failure path.
beforeAll(() => {
  process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-chars-long';
});

function buildLink(opts: { userId: string; chatId: string; userTgId?: string; unlinked?: boolean }) {
  return new TelegramLink({
    telegramChatId: opts.chatId,
    telegramUserId: opts.userTgId ?? opts.chatId,
    userId: opts.userId,
    telegramUsername: 'test_user',
    linkedAt: NOW,
    unlinkedAt: opts.unlinked ? NOW : null,
    lastActiveAt: NOW,
  });
}

class CapturingTransport implements IBotIntentTransport {
  payloads: BotIntentNotification[] = [];
  shouldThrow = false;
  async notify(payload: BotIntentNotification): Promise<void> {
    if (this.shouldThrow) throw new Error('boom');
    this.payloads.push(payload);
  }
}

describe('BotIntentNotificationSchema', () => {
  it('accepts a well-formed inline payload', () => {
    expect(() =>
      BotIntentNotificationSchema.parse({
        telegramChatId: '12345',
        intent: {
          intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
          kind: 'buy',
          tier: 'inline',
          amountUsd6: '50000000',
          intentHash: 'a'.repeat(64),
          expiresAt: NOW.toISOString(),
          payload: { token: TOKEN, summary: 'Buy $50 of TBILL1' },
        },
      }),
    ).not.toThrow();
  });

  it('rejects a malformed intentId', () => {
    expect(() =>
      BotIntentNotificationSchema.parse({
        telegramChatId: '12345',
        intent: {
          intentId: 'not-an-intent',
          kind: 'buy',
          tier: 'inline',
          amountUsd6: '50000000',
          intentHash: 'a'.repeat(64),
          expiresAt: NOW.toISOString(),
          payload: { token: TOKEN, summary: 'Buy' },
        },
      }),
    ).toThrow();
  });

  it('rejects unknown extra keys (strict)', () => {
    expect(() =>
      BotIntentNotificationSchema.parse({
        telegramChatId: '12345',
        injected: 'evil',
        intent: {
          intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
          kind: 'buy',
          tier: 'inline',
          amountUsd6: '50000000',
          intentHash: 'a'.repeat(64),
          expiresAt: NOW.toISOString(),
          payload: { token: TOKEN, summary: 'Buy' },
        },
      }),
    ).toThrow();
  });

  it('accepts an OTP only when present + 6-digit', () => {
    expect(() =>
      BotIntentNotificationSchema.parse({
        telegramChatId: '12345',
        intent: {
          intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
          kind: 'buy',
          tier: 'mini_app_otp',
          amountUsd6: '1500000000',
          intentHash: 'a'.repeat(64),
          expiresAt: NOW.toISOString(),
          payload: { token: TOKEN, summary: 'Buy' },
        },
        otp: '123456',
      }),
    ).not.toThrow();
    expect(() =>
      BotIntentNotificationSchema.parse({
        telegramChatId: '12345',
        intent: {
          intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
          kind: 'buy',
          tier: 'mini_app_otp',
          amountUsd6: '1500000000',
          intentHash: 'a'.repeat(64),
          expiresAt: NOW.toISOString(),
          payload: { token: TOKEN, summary: 'Buy' },
        },
        otp: '12345',
      }),
    ).toThrow();
  });
});

describe('LoggingBotIntentTransport', () => {
  it('returns without throwing for any payload', async () => {
    const t = new LoggingBotIntentTransport();
    await expect(
      t.notify({
        telegramChatId: '12345',
        intent: {
          intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
          kind: 'buy',
          tier: 'inline',
          amountUsd6: '50000000',
          intentHash: 'a'.repeat(64),
          expiresAt: NOW.toISOString(),
          payload: { token: TOKEN, summary: 'Buy' },
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('HttpBotIntentTransport', () => {
  it('POSTs to /intent/notify with the service-secret header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const t = new HttpBotIntentTransport({
        botWorkerUrl: 'http://telegram-bot:3004',
        serviceSecret: 'srv-secret',
      });
      await t.notify({
        telegramChatId: '12345',
        intent: {
          intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
          kind: 'buy',
          tier: 'inline',
          amountUsd6: '50000000',
          intentHash: 'a'.repeat(64),
          expiresAt: NOW.toISOString(),
          payload: { token: TOKEN, summary: 'Buy' },
        },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://telegram-bot:3004/intent/notify');
      expect((init as { method: string }).method).toBe('POST');
      const headers = (init as { headers: Record<string, string> }).headers;
      expect(headers['x-muhaven-service-secret']).toBe('srv-secret');
      expect(headers['content-type']).toBe('application/json');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('swallows fetch failures (telegram outage MUST NOT propagate)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const t = new HttpBotIntentTransport({
        botWorkerUrl: 'http://telegram-bot:3004',
        serviceSecret: 'srv-secret',
      });
      await expect(
        t.notify({
          telegramChatId: '12345',
          intent: {
            intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
            kind: 'buy',
            tier: 'inline',
            amountUsd6: '50000000',
            intentHash: 'a'.repeat(64),
            expiresAt: NOW.toISOString(),
            payload: { token: TOKEN, summary: 'Buy' },
          },
        }),
      ).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('swallows non-2xx responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const t = new HttpBotIntentTransport({
        botWorkerUrl: 'http://telegram-bot:3004',
        serviceSecret: 'srv-secret',
      });
      await expect(
        t.notify({
          telegramChatId: '12345',
          intent: {
            intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
            kind: 'buy',
            tier: 'inline',
            amountUsd6: '50000000',
            intentHash: 'a'.repeat(64),
            expiresAt: NOW.toISOString(),
            payload: { token: TOKEN, summary: 'Buy' },
          },
        }),
      ).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('MintAndDeliverOpenClawIntentUseCase', () => {
  let intentRepo: MemoryOpenClawIntentRepository;
  let createIntent: CreateOpenClawIntentUseCase;
  let linkRepo: MemoryTelegramLinkRepository;
  let transport: CapturingTransport;
  let useCase: MintAndDeliverOpenClawIntentUseCase;

  beforeEach(() => {
    intentRepo = new MemoryOpenClawIntentRepository();
    createIntent = new CreateOpenClawIntentUseCase(intentRepo);
    linkRepo = new MemoryTelegramLinkRepository();
    transport = new CapturingTransport();
    useCase = new MintAndDeliverOpenClawIntentUseCase(createIntent, linkRepo, transport);
  });

  it('returns delivered=false + zero side-effects when no link is bound', async () => {
    const result = await useCase.execute({
      userId: 'u-no-link',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 50_000_000n,
      payload: { token: TOKEN, summary: 'Buy $50 of TBILL1' },
      now: NOW,
    });
    expect(result.delivered).toBe(false);
    expect(transport.payloads).toHaveLength(0);
    const intents = await intentRepo.findByUserId('u-no-link');
    expect(intents).toHaveLength(0);
  });

  it('skips an unlinked link', async () => {
    await linkRepo.upsertLink(
      buildLink({ userId: 'u1', chatId: '12345', unlinked: true }),
    );
    const result = await useCase.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 50_000_000n,
      payload: { token: TOKEN, summary: 'Buy' },
      now: NOW,
    });
    expect(result.delivered).toBe(false);
    expect(transport.payloads).toHaveLength(0);
  });

  it('mints + delivers an inline intent when a live link is bound', async () => {
    await linkRepo.upsertLink(
      buildLink({ userId: 'u1', chatId: '12345', userTgId: '12345' }),
    );
    const result = await useCase.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 50_000_000n,
      payload: { token: TOKEN, summary: 'Buy $50 of TBILL1' },
      now: NOW,
    });
    expect(result.delivered).toBe(true);
    expect(result.tier).toBe(OpenClawIntentTier.Inline);
    expect(transport.payloads).toHaveLength(1);
    const sent = transport.payloads[0]!;
    expect(sent.telegramChatId).toBe('12345');
    expect(sent.intent.tier).toBe('inline');
    expect(sent.intent.kind).toBe('buy');
    expect(sent.intent.amountUsd6).toBe('50000000');
    expect(sent.otp).toBeUndefined();
    expect(sent.intent.intentId).toMatch(/^oci_[A-Z0-9]{26}$/);
    // Intent persisted with the chatId pinned (so confirm-inline can
    // assert `intent.telegramChatId === expectedChatId`).
    const stored = await intentRepo.findById(sent.intent.intentId);
    expect(stored?.telegramChatId).toBe('12345');
  });

  it('forwards the OTP for the mid-tier intent', async () => {
    await linkRepo.upsertLink(buildLink({ userId: 'u1', chatId: '12345' }));
    const result = await useCase.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 1_500_000_000n,
      payload: { token: TOKEN, summary: 'Buy $1500 of TBILL1' },
      now: NOW,
    });
    expect(result.delivered).toBe(true);
    expect(result.tier).toBe(OpenClawIntentTier.MiniAppOtp);
    const sent = transport.payloads[0]!;
    expect(sent.intent.tier).toBe('mini_app_otp');
    expect(sent.otp).toMatch(/^\d{6}$/);
  });

  it('classifies high-tier amounts as passkey_deeplink (and omits OTP)', async () => {
    await linkRepo.upsertLink(buildLink({ userId: 'u1', chatId: '12345' }));
    const result = await useCase.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 25_000_000_000n,
      payload: { token: TOKEN, summary: 'Buy $25000 of TBILL1' },
      now: NOW,
    });
    expect(result.delivered).toBe(true);
    expect(result.tier).toBe(OpenClawIntentTier.PasskeyDeeplink);
    const sent = transport.payloads[0]!;
    expect(sent.intent.tier).toBe('passkey_deeplink');
    expect(sent.otp).toBeUndefined();
  });

  it('does NOT throw when the transport throws (fire-and-forget)', async () => {
    await linkRepo.upsertLink(buildLink({ userId: 'u1', chatId: '12345' }));
    transport.shouldThrow = true;
    await expect(
      useCase.execute({
        userId: 'u1',
        kind: OpenClawIntentKind.Buy,
        amountUsd6: 50_000_000n,
        payload: { token: TOKEN, summary: 'Buy' },
        now: NOW,
      }),
    ).resolves.toEqual(
      expect.objectContaining({ delivered: true, tier: OpenClawIntentTier.Inline }),
    );
    // Intent was still minted even though the transport blew up — the
    // bot can re-deliver via lookup if a Wave 5 retry path is added.
    const intents = await intentRepo.findByUserId('u1');
    expect(intents).toHaveLength(1);
  });

  it('does NOT throw when the link repo throws', async () => {
    const brokenRepo = {
      findByUserId: vi.fn().mockRejectedValue(new Error('db down')),
      upsertLink: vi.fn(),
      findByChatId: vi.fn(),
      findByTelegramUserId: vi.fn(),
      unlink: vi.fn(),
      touchLastActive: vi.fn(),
    };
    const uc = new MintAndDeliverOpenClawIntentUseCase(
      createIntent,
      brokenRepo as unknown as MemoryTelegramLinkRepository,
      transport,
    );
    const result = await uc.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 50_000_000n,
      payload: { token: TOKEN, summary: 'Buy' },
      now: NOW,
    });
    expect(result.delivered).toBe(false);
    expect(transport.payloads).toHaveLength(0);
  });
});
