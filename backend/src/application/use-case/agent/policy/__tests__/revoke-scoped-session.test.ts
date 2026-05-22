import { describe, it, expect, beforeEach } from 'vitest';
import { ScopedSession } from '../../../../../domain/agent/model/scoped-session.js';
import { ScopedSessionStatus } from '../../../../../domain/agent/model/scoped-session-status.enum.js';
import { Surface } from '../../../../../domain/agent/model/surface.enum.js';
import { MemoryScopedSessionRepository } from '../../../../../infrastructure/repository/memory/memory-scoped-session.repository.js';
import { RevokeScopedSessionUseCase } from '../revoke-scoped-session.use-case.js';

const NOW = new Date('2026-05-22T12:00:00.000Z');

function seed(repo: MemoryScopedSessionRepository, overrides: Partial<ConstructorParameters<typeof ScopedSession>[0]> = {}): ScopedSession {
  const session = new ScopedSession({
    sessionId: 'session-abc-123',
    userId: 'u1',
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

describe('RevokeScopedSessionUseCase', () => {
  let repo: MemoryScopedSessionRepository;
  let useCase: RevokeScopedSessionUseCase;

  beforeEach(() => {
    repo = new MemoryScopedSessionRepository();
    useCase = new RevokeScopedSessionUseCase(repo);
  });

  it('happy path — flips active session to revoked', async () => {
    seed(repo);
    const result = await useCase.execute({
      userId: 'u1',
      sessionId: 'session-abc-123',
      now: NOW,
    });
    expect(result.session.status).toBe(ScopedSessionStatus.Revoked);
    expect(result.session.revokedAt).toEqual(NOW);
    const reloaded = await repo.findById('session-abc-123');
    expect(reloaded?.status).toBe(ScopedSessionStatus.Revoked);
  });

  it('rejects with 404 when sessionId does not exist (masks existence)', async () => {
    await expect(
      useCase.execute({ userId: 'u1', sessionId: 'session-does-not-exist', now: NOW }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects with 404 when sessionId exists but belongs to a different user (masks ownership)', async () => {
    seed(repo);
    await expect(
      useCase.execute({ userId: 'u2', sessionId: 'session-abc-123', now: NOW }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects with 409 when session already revoked (idempotency surface)', async () => {
    seed(repo, { status: ScopedSessionStatus.Revoked, revokedAt: new Date() });
    await expect(
      useCase.execute({ userId: 'u1', sessionId: 'session-abc-123', now: NOW }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects with 409 when session is expired terminal status', async () => {
    seed(repo, { status: ScopedSessionStatus.Expired, expiredAt: new Date() });
    await expect(
      useCase.execute({ userId: 'u1', sessionId: 'session-abc-123', now: NOW }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
