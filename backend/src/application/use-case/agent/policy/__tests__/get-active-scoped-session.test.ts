import { describe, it, expect, beforeEach } from 'vitest';
import { ScopedSession } from '../../../../../domain/agent/model/scoped-session.js';
import { ScopedSessionStatus } from '../../../../../domain/agent/model/scoped-session-status.enum.js';
import { Surface } from '../../../../../domain/agent/model/surface.enum.js';
import { MemoryScopedSessionRepository } from '../../../../../infrastructure/repository/memory/memory-scoped-session.repository.js';
import { GetActiveScopedSessionUseCase } from '../get-active-scoped-session.use-case.js';

const NOW = new Date('2026-05-22T12:00:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

function makeSession(overrides: Partial<ConstructorParameters<typeof ScopedSession>[0]> = {}): ScopedSession {
  return new ScopedSession({
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
    validUntilSec: NOW_SEC + 3600,
    mintedAtSec: NOW_SEC,
    consentActionHash: null,
    consentTextSha256: null,
    mintedAt: NOW,
    revokedAt: null,
    expiredAt: null,
    ...overrides,
  });
}

describe('GetActiveScopedSessionUseCase', () => {
  let repo: MemoryScopedSessionRepository;
  let useCase: GetActiveScopedSessionUseCase;

  beforeEach(() => {
    repo = new MemoryScopedSessionRepository();
    useCase = new GetActiveScopedSessionUseCase(repo);
  });

  it('returns the active session for (user, surface)', async () => {
    await repo.create(makeSession());
    const result = await useCase.execute({
      userId: 'u1',
      surface: Surface.MCP,
      now: NOW,
    });
    expect(result?.sessionId).toBe('session-abc-123');
  });

  it('returns null when no row matches user+surface', async () => {
    await repo.create(makeSession());
    const result = await useCase.execute({
      userId: 'u2',
      surface: Surface.MCP,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('returns null when only revoked rows exist for user+surface', async () => {
    await repo.create(
      makeSession({ status: ScopedSessionStatus.Revoked, revokedAt: NOW }),
    );
    const result = await useCase.execute({
      userId: 'u1',
      surface: Surface.MCP,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('returns null when only expired-by-clock rows exist (validUntilSec <= nowSec)', async () => {
    await repo.create(makeSession({ validUntilSec: NOW_SEC - 1 }));
    const result = await useCase.execute({
      userId: 'u1',
      surface: Surface.MCP,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('returns the most-recently-minted active session that ISN\'T revoked, even with a prior revoked row', async () => {
    // Partial UNIQUE makes "multiple active rows" structurally impossible
    // — but the realistic mint/revoke/mint cycle leaves a revoked row +
    // a fresh active row. The use-case must return the active one even
    // when both share (userId, surface).
    const oldRevoked = makeSession({
      sessionId: 'session-revoked',
      status: ScopedSessionStatus.Revoked,
      revokedAt: new Date(NOW.getTime() - 30_000),
      mintedAt: new Date(NOW.getTime() - 60_000),
    });
    const freshActive = makeSession({
      sessionId: 'session-active',
      mintedAt: NOW,
    });
    await repo.create(oldRevoked);
    await repo.create(freshActive);
    const result = await useCase.execute({
      userId: 'u1',
      surface: Surface.MCP,
      now: NOW,
    });
    expect(result?.sessionId).toBe('session-active');
  });

  it('does not cross surfaces for the same user', async () => {
    await repo.create(makeSession({ surface: Surface.HavenBot }));
    const result = await useCase.execute({
      userId: 'u1',
      surface: Surface.MCP,
      now: NOW,
    });
    expect(result).toBeNull();
  });
});
