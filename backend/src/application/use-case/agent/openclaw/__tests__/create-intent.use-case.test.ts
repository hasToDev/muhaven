import { describe, expect, it, beforeEach } from 'vitest';
import { CreateOpenClawIntentUseCase } from '../create-intent.use-case.js';
import {
  OpenClawIntentKind,
  OpenClawIntentStatus,
  OpenClawIntentTier,
  TIER_INLINE_MAX_USD6,
  TIER_MINI_APP_MAX_USD6,
} from '../../../../../domain/agent/model/openclaw-intent.js';
import { MemoryOpenClawIntentRepository } from '../../../../../infrastructure/repository/memory/index.js';

const NOW = new Date('2026-04-30T00:00:00.000Z');

describe('CreateOpenClawIntentUseCase', () => {
  let repo: MemoryOpenClawIntentRepository;
  let useCase: CreateOpenClawIntentUseCase;

  beforeEach(() => {
    repo = new MemoryOpenClawIntentRepository();
    useCase = new CreateOpenClawIntentUseCase(repo);
  });

  it('mints an Inline tier intent for amounts ≤$200', async () => {
    const result = await useCase.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 50_000_000n, // $50
      payload: { token: '0x1111111111111111111111111111111111111111', summary: 'Buy $50 of TBILL-A' },
      now: NOW,
    });
    expect(result.intent.tier).toBe(OpenClawIntentTier.Inline);
    expect(result.intent.status).toBe(OpenClawIntentStatus.Pending);
    expect(result.intent.otp).toBeNull();
    expect(result.otp).toBeUndefined();
  });

  it('mints a MiniAppOtp tier intent for amounts in ($200, $5000]', async () => {
    const result = await useCase.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 1_500_000_000n, // $1500
      payload: { token: '0x1111111111111111111111111111111111111111', summary: 'Buy $1500' },
      now: NOW,
    });
    expect(result.intent.tier).toBe(OpenClawIntentTier.MiniAppOtp);
    expect(result.intent.otp).toMatch(/^\d{6}$/);
    expect(result.otp).toBe(result.intent.otp);
  });

  it('mints a PasskeyDeeplink tier intent for amounts >$5000', async () => {
    const result = await useCase.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 25_000_000_000n, // $25000
      payload: { token: '0x1111111111111111111111111111111111111111', summary: 'Buy $25000' },
      now: NOW,
    });
    expect(result.intent.tier).toBe(OpenClawIntentTier.PasskeyDeeplink);
    expect(result.intent.otp).toBeNull();
    expect(result.otp).toBeUndefined();
  });

  it('places the boundary $200 in the Inline tier (≤ semantics)', async () => {
    const result = await useCase.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: TIER_INLINE_MAX_USD6,
      payload: { token: '0x1111111111111111111111111111111111111111', summary: 'Buy exactly $200' },
      now: NOW,
    });
    expect(result.intent.tier).toBe(OpenClawIntentTier.Inline);
  });

  it('places the boundary $5000 in the MiniAppOtp tier (≤ semantics)', async () => {
    const result = await useCase.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: TIER_MINI_APP_MAX_USD6,
      payload: { token: '0x1111111111111111111111111111111111111111', summary: 'Buy exactly $5000' },
      now: NOW,
    });
    expect(result.intent.tier).toBe(OpenClawIntentTier.MiniAppOtp);
  });

  it('rejects negative amounts', async () => {
    await expect(
      useCase.execute({
        userId: 'u1',
        kind: OpenClawIntentKind.Buy,
        amountUsd6: -1n,
        payload: { token: '0x1111111111111111111111111111111111111111', summary: 'oops' },
        now: NOW,
      }),
    ).rejects.toThrow(/non-negative/);
  });

  it('produces deterministic intentHash for semantically equal payloads', async () => {
    const r1 = await useCase.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 50_000_000n,
      payload: { token: '0x1111111111111111111111111111111111111111', summary: 'Buy $50', issuerLabel: 'Acme' },
      now: NOW,
    });
    const r2 = await useCase.execute({
      // Same payload, key order intentionally different to test stable-stringify.
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 50_000_000n,
      payload: { issuerLabel: 'Acme', summary: 'Buy $50', token: '0x1111111111111111111111111111111111111111' },
      now: NOW,
    });
    expect(r1.intent.intentHash).toBe(r2.intent.intentHash);
    // intentIds must be unique even with identical payload + timestamp.
    expect(r1.intent.intentId).not.toBe(r2.intent.intentId);
  });

  it('mints an intentId matching the oci_<26-base32> format', async () => {
    const r = await useCase.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Claim,
      amountUsd6: 0n,
      payload: { token: '0x1111111111111111111111111111111111111111', summary: 'Claim all' },
      now: NOW,
    });
    expect(r.intent.intentId).toMatch(/^oci_[A-Z0-9]{26}$/);
  });

  it('persists the minted intent and round-trips', async () => {
    const r = await useCase.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 1_500_000_000n,
      payload: { token: '0x1111111111111111111111111111111111111111', summary: 'Buy $1500' },
      now: NOW,
      telegramChatId: '12345',
    });
    const found = await repo.findById(r.intent.intentId);
    expect(found?.intentHash).toBe(r.intent.intentHash);
    expect(found?.telegramChatId).toBe('12345');
    expect(found?.otp).toBe(r.otp);
  });

  // ── Tier-threshold override (staging-only knob) ──────────────────────

  describe('tier-threshold override', () => {
    it('routes a $2 amount to MiniAppOtp when inline ceiling is lowered to 0', async () => {
      const lowered = new CreateOpenClawIntentUseCase(repo, {
        inlineMaxUsd6: 0n,
        miniAppMaxUsd6: 5_000_000_000n,
      });
      const r = await lowered.execute({
        userId: 'u1',
        kind: OpenClawIntentKind.Buy,
        amountUsd6: 2_000_000n,
        payload: { token: '0x1111111111111111111111111111111111111111', summary: 'Buy $2' },
        now: NOW,
      });
      expect(r.intent.tier).toBe(OpenClawIntentTier.MiniAppOtp);
      // OTP minted because mid-tier is the OTP-bearing tier.
      expect(r.otp).toMatch(/^\d{6}$/);
    });

    it('rejects an inline ceiling that exceeds the regulatory cap', () => {
      const raised = new CreateOpenClawIntentUseCase(repo, {
        inlineMaxUsd6: 10_000_000_000n, // $10K — above the $200 regulator cap
        miniAppMaxUsd6: 20_000_000_000n,
      });
      // The validator runs inside `classifyTier` on first execute() call.
      return expect(
        raised.execute({
          userId: 'u1',
          kind: OpenClawIntentKind.Buy,
          amountUsd6: 50_000_000n,
          payload: { token: '0x1111111111111111111111111111111111111111', summary: 'Buy $50' },
          now: NOW,
        }),
      ).rejects.toThrow(/inline tier ceiling override.*exceeds the regulatory cap/);
    });

    it('rejects a mini-app ceiling that exceeds the regulatory cap', () => {
      const raised = new CreateOpenClawIntentUseCase(repo, {
        inlineMaxUsd6: 100_000_000n, // $100 (legal)
        miniAppMaxUsd6: 100_000_000_000n, // $100K (illegal)
      });
      return expect(
        raised.execute({
          userId: 'u1',
          kind: OpenClawIntentKind.Buy,
          amountUsd6: 50_000_000n,
          payload: { token: '0x1111111111111111111111111111111111111111', summary: 'Buy $50' },
          now: NOW,
        }),
      ).rejects.toThrow(/mini_app_otp tier ceiling override.*exceeds the regulatory cap/);
    });

    it('rejects an inline ceiling above the mini-app ceiling', () => {
      const inverted = new CreateOpenClawIntentUseCase(repo, {
        inlineMaxUsd6: 100_000_000n, // $100
        miniAppMaxUsd6: 50_000_000n, // $50
      });
      return expect(
        inverted.execute({
          userId: 'u1',
          kind: OpenClawIntentKind.Buy,
          amountUsd6: 25_000_000n,
          payload: { token: '0x1111111111111111111111111111111111111111', summary: 'Buy' },
          now: NOW,
        }),
      ).rejects.toThrow(/inline ceiling.*must be ≤ mini_app_otp ceiling/);
    });
  });
});
