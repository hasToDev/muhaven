import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Defense-in-depth env seed (matches the sibling revoke test).
beforeAll(() => {
  process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-chars-long';
});

// Quiet + assertable logger (the use-case logs a warn on the unreachable
// 404-skip branch; the inner revoke use-case logs on audit-throw).
const { loggerWarnSpy, loggerErrorSpy } = vi.hoisted(() => ({
  loggerWarnSpy: vi.fn(),
  loggerErrorSpy: vi.fn(),
}));
vi.mock('../../../../../core/logger.js', () => ({
  getLogger: (_name?: string) => ({
    error: loggerErrorSpy,
    warn: loggerWarnSpy,
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => ({
      error: loggerErrorSpy,
      warn: loggerWarnSpy,
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    }),
  }),
}));

import { ApplicationHttpError } from '../../../../../core/errors.js';
import { AuditEventType } from '../../../../../domain/agent/model/audit-event-type.enum.js';
import { ScopedSession } from '../../../../../domain/agent/model/scoped-session.js';
import { ScopedSessionStatus } from '../../../../../domain/agent/model/scoped-session-status.enum.js';
import { Surface } from '../../../../../domain/agent/model/surface.enum.js';
import { TelegramLink } from '../../../../../domain/agent/model/telegram-link.js';
import { AppendAuditEventUseCase } from '../append-audit-event.use-case.js';
import { MemoryAgentAuditRepository } from '../../../../../infrastructure/repository/memory/memory-agent-audit.repository.js';
import { MemoryScopedSessionRepository } from '../../../../../infrastructure/repository/memory/memory-scoped-session.repository.js';
import { MemoryTelegramLinkRepository } from '../../../../../infrastructure/repository/memory/memory-telegram-link.repository.js';
import { RevokeScopedSessionUseCase } from '../revoke-scoped-session.use-case.js';
import { RevokeActiveSessionsForChatUseCase } from '../revoke-active-sessions-for-chat.use-case.js';

const NOW = new Date('2026-05-30T12:00:00.000Z');
const CHAT_ID = '987654321';
const USER_ID = 'u1';

function seedSession(
  repo: MemoryScopedSessionRepository,
  overrides: Partial<ConstructorParameters<typeof ScopedSession>[0]> = {},
): ScopedSession {
  const session = new ScopedSession({
    sessionId: 'session-mcp-1',
    userId: USER_ID,
    surface: Surface.MCP,
    status: ScopedSessionStatus.Active,
    signerAddress: '0xaaaa000000000000000000000000000000000001',
    permissionId: null,
    targetContracts: ['0xbbbb000000000000000000000000000000000002'],
    selectorCaps: [{ selector: '0xdeadbeef', capArgIndex: 2, maxAmount: '1000000' }],
    maxPerOpUsd6: 100_000_000n,
    totalSpentUsd6: 0n,
    validUntilSec: 2_000_000_000,
    mintedAtSec: 1_000_000_000,
    consentActionHash: null,
    consentTextSha256: null,
    mintedAt: NOW,
    revokedAt: null,
    expiredAt: null,
    ...overrides,
  });
  void repo.create(session);
  return session;
}

function seedLink(
  repo: MemoryTelegramLinkRepository,
  overrides: Partial<ConstructorParameters<typeof TelegramLink>[0]> = {},
): void {
  void repo.upsertLink(
    new TelegramLink({
      telegramChatId: CHAT_ID,
      telegramUserId: CHAT_ID,
      userId: USER_ID,
      telegramUsername: 'alice',
      linkedAt: NOW,
      unlinkedAt: null,
      lastActiveAt: null,
      ...overrides,
    }),
  );
}

describe('RevokeActiveSessionsForChatUseCase', () => {
  let scopedRepo: MemoryScopedSessionRepository;
  let auditRepo: MemoryAgentAuditRepository;
  let linkRepo: MemoryTelegramLinkRepository;
  let revokeInner: RevokeScopedSessionUseCase;
  let useCase: RevokeActiveSessionsForChatUseCase;

  beforeEach(() => {
    scopedRepo = new MemoryScopedSessionRepository();
    auditRepo = new MemoryAgentAuditRepository();
    linkRepo = new MemoryTelegramLinkRepository();
    revokeInner = new RevokeScopedSessionUseCase(
      scopedRepo,
      new AppendAuditEventUseCase(auditRepo),
    );
    useCase = new RevokeActiveSessionsForChatUseCase(linkRepo, scopedRepo, revokeInner);
    loggerWarnSpy.mockClear();
    loggerErrorSpy.mockClear();
  });

  it('happy path — revokes the single active session + writes audit', async () => {
    seedLink(linkRepo);
    seedSession(scopedRepo);

    const result = await useCase.execute({ telegramChatId: CHAT_ID, now: NOW });

    expect(result).toEqual({ userId: USER_ID, found: 1, revoked: 1 });
    const reloaded = await scopedRepo.findById('session-mcp-1');
    expect(reloaded?.status).toBe(ScopedSessionStatus.Revoked);
    const audit = await auditRepo.findByUserId(USER_ID);
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0].eventType).toBe(AuditEventType.ScopedSessionRevoked);
    expect(audit.items[0].surface).toBe(Surface.MCP);
  });

  it('surface-agnostic — revokes active sessions across every surface', async () => {
    seedLink(linkRepo);
    seedSession(scopedRepo, { sessionId: 'session-mcp-1', surface: Surface.MCP });
    seedSession(scopedRepo, {
      sessionId: 'session-hb-1',
      surface: Surface.HavenBot,
    });

    const result = await useCase.execute({ telegramChatId: CHAT_ID, now: NOW });

    expect(result.revoked).toBe(2);
    expect((await scopedRepo.findById('session-mcp-1'))?.status).toBe(
      ScopedSessionStatus.Revoked,
    );
    expect((await scopedRepo.findById('session-hb-1'))?.status).toBe(
      ScopedSessionStatus.Revoked,
    );
    // One audit row per revoked session.
    expect((await auditRepo.findByUserId(USER_ID)).items).toHaveLength(2);
  });

  it('rejects with 404 when the chat is not linked', async () => {
    seedSession(scopedRepo); // session exists but no link row
    await expect(
      useCase.execute({ telegramChatId: CHAT_ID, now: NOW }),
    ).rejects.toMatchObject({ statusCode: 404 });
    // No revoke happened.
    expect((await scopedRepo.findById('session-mcp-1'))?.status).toBe(
      ScopedSessionStatus.Active,
    );
  });

  it('rejects with 404 when the chat link is unlinked (terminal)', async () => {
    seedLink(linkRepo, { unlinkedAt: NOW });
    seedSession(scopedRepo);
    await expect(
      useCase.execute({ telegramChatId: CHAT_ID, now: NOW }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects with 409 when the linked user has no active session', async () => {
    seedLink(linkRepo);
    // No session, or only a terminal one.
    seedSession(scopedRepo, { status: ScopedSessionStatus.Revoked, revokedAt: NOW });
    await expect(
      useCase.execute({ telegramChatId: CHAT_ID, now: NOW }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('does not touch another user’s session (ownership via chat binding)', async () => {
    seedLink(linkRepo); // chat → u1
    // A session owned by u2 — must NOT be revoked by u1's kill-switch.
    seedSession(scopedRepo, { sessionId: 'session-u2', userId: 'u2' });
    await expect(
      useCase.execute({ telegramChatId: CHAT_ID, now: NOW }),
    ).rejects.toMatchObject({ statusCode: 409 }); // u1 has nothing active
    expect((await scopedRepo.findById('session-u2'))?.status).toBe(
      ScopedSessionStatus.Active,
    );
  });

  it('skips a session that raced to terminal (benign 409 from inner use-case)', async () => {
    seedLink(linkRepo);
    seedSession(scopedRepo, { sessionId: 'session-a', surface: Surface.MCP });
    seedSession(scopedRepo, { sessionId: 'session-b', surface: Surface.HavenBot });
    // session-a races to terminal between lookup and revoke → inner 409.
    const spy = vi
      .spyOn(revokeInner, 'execute')
      .mockImplementationOnce(async () => {
        throw ApplicationHttpError.conflict('already revoked');
      });
    const result = await useCase.execute({ telegramChatId: CHAT_ID, now: NOW });
    // session-a skipped (409), session-b revoked → found 2, revoked 1.
    expect(result.found).toBe(2);
    expect(result.revoked).toBe(1);
    spy.mockRestore();
  });

  it('re-throws a genuine inner failure (e.g. audit-table outage 500)', async () => {
    seedLink(linkRepo);
    seedSession(scopedRepo);
    const spy = vi.spyOn(revokeInner, 'execute').mockImplementationOnce(async () => {
      throw new Error('simulated audit-table outage');
    });
    await expect(
      useCase.execute({ telegramChatId: CHAT_ID, now: NOW }),
    ).rejects.toThrow(/simulated audit-table outage/);
    spy.mockRestore();
  });
});
