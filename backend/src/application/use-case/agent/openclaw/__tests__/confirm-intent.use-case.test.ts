import { describe, expect, it, beforeEach } from 'vitest';
import {
  ConfirmOpenClawIntentUseCase,
  DenyOpenClawIntentUseCase,
  LookupOpenClawIntentUseCase,
} from '../confirm-intent.use-case.js';
import { CreateOpenClawIntentUseCase } from '../create-intent.use-case.js';
import {
  OpenClawIntentKind,
  OpenClawIntentStatus,
} from '../../../../../domain/agent/model/openclaw-intent.js';
import {
  MemoryAgentAuditRepository,
  MemoryOpenClawIntentRepository,
} from '../../../../../infrastructure/repository/memory/index.js';
import { AppendAuditEventUseCase } from '../../policy/append-audit-event.use-case.js';
import { ApplicationHttpError } from '../../../../../core/errors.js';

const TOKEN = '0x1111111111111111111111111111111111111111' as const;
const NOW = new Date('2026-04-30T00:00:00.000Z');
const TWO_MIN_LATER = new Date(NOW.getTime() + 2 * 60 * 1000);
const SIX_MIN_LATER = new Date(NOW.getTime() + 6 * 60 * 1000);

interface Harness {
  intentRepo: MemoryOpenClawIntentRepository;
  auditRepo: MemoryAgentAuditRepository;
  create: CreateOpenClawIntentUseCase;
  confirm: ConfirmOpenClawIntentUseCase;
  deny: DenyOpenClawIntentUseCase;
  lookup: LookupOpenClawIntentUseCase;
}

function harness(): Harness {
  const intentRepo = new MemoryOpenClawIntentRepository();
  const auditRepo = new MemoryAgentAuditRepository();
  const append = new AppendAuditEventUseCase(auditRepo);
  return {
    intentRepo,
    auditRepo,
    create: new CreateOpenClawIntentUseCase(intentRepo),
    confirm: new ConfirmOpenClawIntentUseCase(intentRepo, append),
    deny: new DenyOpenClawIntentUseCase(intentRepo, append),
    lookup: new LookupOpenClawIntentUseCase(intentRepo),
  };
}

describe('ConfirmOpenClawIntentUseCase — Inline tier', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('confirms a fresh inline intent', async () => {
    const r = await h.create.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 50_000_000n, // $50 — Inline
      payload: { token: TOKEN, summary: 'Buy $50' },
      now: NOW,
    });
    const confirmed = await h.confirm.execute({
      intentId: r.intent.intentId,
      userId: 'u1',
      source: 'telegram_inline',
      now: TWO_MIN_LATER,
    });
    expect(confirmed.status).toBe(OpenClawIntentStatus.Confirmed);
    expect(confirmed.confirmedAt).toEqual(TWO_MIN_LATER);
  });

  it('rejects confirm by a different user', async () => {
    const r = await h.create.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 50_000_000n,
      payload: { token: TOKEN, summary: 'Buy $50' },
      now: NOW,
    });
    await expect(
      h.confirm.execute({ intentId: r.intent.intentId, userId: 'u2', now: TWO_MIN_LATER }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects double confirm (replay)', async () => {
    const r = await h.create.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 50_000_000n,
      payload: { token: TOKEN, summary: 'Buy $50' },
      now: NOW,
    });
    await h.confirm.execute({ intentId: r.intent.intentId, userId: 'u1', now: TWO_MIN_LATER });
    await expect(
      h.confirm.execute({ intentId: r.intent.intentId, userId: 'u1', now: TWO_MIN_LATER }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('expires after the TTL window', async () => {
    const r = await h.create.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 50_000_000n,
      payload: { token: TOKEN, summary: 'Buy $50' },
      now: NOW,
    });
    // Inline TTL = 5 minutes; SIX_MIN_LATER expires it.
    await expect(
      h.confirm.execute({ intentId: r.intent.intentId, userId: 'u1', now: SIX_MIN_LATER }),
    ).rejects.toMatchObject({ statusCode: 410 });
  });
});

describe('ConfirmOpenClawIntentUseCase — MiniAppOtp tier', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('confirms when OTP matches', async () => {
    const r = await h.create.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 1_500_000_000n, // $1500 — MiniAppOtp
      payload: { token: TOKEN, summary: 'Buy $1500' },
      now: NOW,
    });
    const confirmed = await h.confirm.execute({
      intentId: r.intent.intentId,
      userId: 'u1',
      otp: r.otp!,
      source: 'mini_app',
      now: TWO_MIN_LATER,
    });
    expect(confirmed.status).toBe(OpenClawIntentStatus.Confirmed);
  });

  it('rejects confirm without OTP', async () => {
    const r = await h.create.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 1_500_000_000n,
      payload: { token: TOKEN, summary: 'Buy $1500' },
      now: NOW,
    });
    await expect(
      h.confirm.execute({ intentId: r.intent.intentId, userId: 'u1', now: TWO_MIN_LATER }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects malformed OTP (length)', async () => {
    const r = await h.create.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 1_500_000_000n,
      payload: { token: TOKEN, summary: 'Buy $1500' },
      now: NOW,
    });
    await expect(
      h.confirm.execute({
        intentId: r.intent.intentId,
        userId: 'u1',
        otp: '12345',
        now: TWO_MIN_LATER,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects malformed OTP (non-digit)', async () => {
    const r = await h.create.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 1_500_000_000n,
      payload: { token: TOKEN, summary: 'Buy $1500' },
      now: NOW,
    });
    await expect(
      h.confirm.execute({
        intentId: r.intent.intentId,
        userId: 'u1',
        otp: 'abcdef',
        now: TWO_MIN_LATER,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects wrong OTP (lost the race)', async () => {
    const r = await h.create.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 1_500_000_000n,
      payload: { token: TOKEN, summary: 'Buy $1500' },
      now: NOW,
    });
    // Build a guaranteed-different OTP by flipping a digit.
    const wrong = (Number.parseInt(r.otp!, 10) + 1).toString().padStart(6, '0');
    await expect(
      h.confirm.execute({
        intentId: r.intent.intentId,
        userId: 'u1',
        otp: wrong,
        now: TWO_MIN_LATER,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('LookupOpenClawIntentUseCase — collapsed-oracle 404s', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('returns the public summary on success', async () => {
    const r = await h.create.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 50_000_000n,
      payload: { token: TOKEN, summary: 'Buy $50' },
      now: NOW,
    });
    const summary = await h.lookup.execute({
      intentId: r.intent.intentId,
      expectedUserId: 'u1',
      now: TWO_MIN_LATER,
    });
    expect(summary.intentId).toBe(r.intent.intentId);
    expect(summary.amountUsd6).toBe('50000000');
    expect(summary.intentHash).toBe(r.intent.intentHash);
  });

  it('returns 404 for unknown intent', async () => {
    await expect(
      h.lookup.execute({
        intentId: 'oci_AAAAAAAAAAAAAAAAAAAAAAAAAA',
        expectedUserId: 'u1',
        now: TWO_MIN_LATER,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns 404 for cross-user lookup', async () => {
    const r = await h.create.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 50_000_000n,
      payload: { token: TOKEN, summary: 'Buy $50' },
      now: NOW,
    });
    await expect(
      h.lookup.execute({
        intentId: r.intent.intentId,
        expectedUserId: 'u2',
        now: TWO_MIN_LATER,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns 404 for confirmed intent (not pending)', async () => {
    const r = await h.create.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 50_000_000n,
      payload: { token: TOKEN, summary: 'Buy $50' },
      now: NOW,
    });
    await h.confirm.execute({ intentId: r.intent.intentId, userId: 'u1', now: TWO_MIN_LATER });
    await expect(
      h.lookup.execute({
        intentId: r.intent.intentId,
        expectedUserId: 'u1',
        now: TWO_MIN_LATER,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns 404 when the chat id does not match the expectedChatId', async () => {
    const r = await h.create.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 1_500_000_000n,
      payload: { token: TOKEN, summary: 'Buy $1500' },
      now: NOW,
      telegramChatId: '12345',
    });
    await expect(
      h.lookup.execute({
        intentId: r.intent.intentId,
        expectedUserId: 'u1',
        expectedChatId: '67890',
        now: TWO_MIN_LATER,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('DenyOpenClawIntentUseCase', () => {
  it('denies a pending intent and writes an audit event', async () => {
    const h = harness();
    const r = await h.create.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 50_000_000n,
      payload: { token: TOKEN, summary: 'Buy $50' },
      now: NOW,
    });
    const denied = await h.deny.execute({
      intentId: r.intent.intentId,
      userId: 'u1',
      reason: 'user_clicked_deny',
      now: TWO_MIN_LATER,
    });
    expect(denied.status).toBe(OpenClawIntentStatus.Denied);
    expect(denied.denyReason).toBe('user_clicked_deny');

    const events = await h.auditRepo.findByUserId('u1', { limit: 10 });
    expect(events.items.length).toBeGreaterThan(0);
    expect(events.items[0]!.eventType).toBe('permit_revoked');
  });

  it('rejects deny on already-confirmed intent', async () => {
    const h = harness();
    const r = await h.create.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 50_000_000n,
      payload: { token: TOKEN, summary: 'Buy $50' },
      now: NOW,
    });
    await h.confirm.execute({ intentId: r.intent.intentId, userId: 'u1', now: TWO_MIN_LATER });
    await expect(
      h.deny.execute({ intentId: r.intent.intentId, userId: 'u1', now: TWO_MIN_LATER }),
    ).rejects.toMatchObject({ statusCode: 410 });
  });
});

describe('AuditEvents — confirm path', () => {
  it('writes a permit_granted event with intentId + tier metadata on confirm', async () => {
    const h = harness();
    const r = await h.create.execute({
      userId: 'u1',
      kind: OpenClawIntentKind.Buy,
      amountUsd6: 50_000_000n,
      payload: { token: TOKEN, summary: 'Buy $50' },
      now: NOW,
    });
    await h.confirm.execute({
      intentId: r.intent.intentId,
      userId: 'u1',
      source: 'telegram_inline',
      now: TWO_MIN_LATER,
    });
    const events = await h.auditRepo.findByUserId('u1', { limit: 10 });
    expect(events.items.length).toBeGreaterThan(0);
    const evt = events.items[0]!;
    expect(evt.eventType).toBe('permit_granted');
    expect(evt.surface).toBe('openclaw');
    expect((evt.metadata as { intentId?: string }).intentId).toBe(r.intent.intentId);
  });
});
