import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Defense-in-depth env seed (vi.mock below replaces getLogger, so the
// real env-schema parse never fires; left in case import order shifts).
beforeAll(() => {
  process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-chars-long';
});

// Reality Checker MED-3 pre-Codex: pin the compensating control
// (structured `orphanMirrorRow:true` log) load-bearingly. Without
// this mock + assertion, a regression that drops the structured log
// call from the audit-throw catch block would silently break the
// operator's grep-based reconciliation runbook with zero test signal.
const { loggerErrorSpy } = vi.hoisted(() => ({
  loggerErrorSpy: vi.fn(),
}));
vi.mock('../../../../../core/logger.js', () => ({
  getLogger: (_name?: string) => ({
    error: loggerErrorSpy,
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => ({
      error: loggerErrorSpy,
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    }),
  }),
}));

import { AuditEventType } from '../../../../../domain/agent/model/audit-event-type.enum.js';
import { ScopedSession } from '../../../../../domain/agent/model/scoped-session.js';
import { ScopedSessionStatus } from '../../../../../domain/agent/model/scoped-session-status.enum.js';
import { Surface } from '../../../../../domain/agent/model/surface.enum.js';
import { AppendAuditEventUseCase } from '../append-audit-event.use-case.js';
import { MemoryAgentAuditRepository } from '../../../../../infrastructure/repository/memory/memory-agent-audit.repository.js';
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
  let auditRepo: MemoryAgentAuditRepository;
  let appendAudit: AppendAuditEventUseCase;
  let useCase: RevokeScopedSessionUseCase;

  beforeEach(() => {
    repo = new MemoryScopedSessionRepository();
    auditRepo = new MemoryAgentAuditRepository();
    appendAudit = new AppendAuditEventUseCase(auditRepo);
    useCase = new RevokeScopedSessionUseCase(repo, appendAudit);
    loggerErrorSpy.mockClear();
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

  // ── Commit 2.B — audit emission (Security M-2 forensic chain) ──

  describe('audit emission (Commit 2.B)', () => {
    it('writes a ScopedSessionRevoked row on the happy path', async () => {
      seed(repo);
      await useCase.execute({
        userId: 'u1',
        sessionId: 'session-abc-123',
        now: NOW,
      });

      const page = await auditRepo.findByUserId('u1');
      expect(page.items).toHaveLength(1);
      const event = page.items[0];
      expect(event.eventType).toBe(AuditEventType.ScopedSessionRevoked);
      expect(event.surface).toBe(Surface.MCP);
      expect(event.userId).toBe('u1');
      expect(event.createdAt).toEqual(NOW);
      expect(event.metadata).toEqual({
        sessionId: 'session-abc-123',
        revokedAt: NOW.toISOString(),
      });
    });

    it('does NOT emit when ownership-mask 404 fires (no spurious revoke row)', async () => {
      // A user A trying to revoke user B's session would land an audit
      // row against user A IF emission ran ahead of the ownership check.
      // Verify the emission is gated by successful repo.revoke.
      seed(repo); // owner: u1
      await expect(
        useCase.execute({ userId: 'u2', sessionId: 'session-abc-123', now: NOW }),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect((await auditRepo.findByUserId('u1')).items).toHaveLength(0);
      expect((await auditRepo.findByUserId('u2')).items).toHaveLength(0);
    });

    it('does NOT emit when sessionId is unknown (404 mask)', async () => {
      await expect(
        useCase.execute({
          userId: 'u1',
          sessionId: 'session-does-not-exist',
          now: NOW,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect((await auditRepo.findByUserId('u1')).items).toHaveLength(0);
    });

    it('does NOT emit on the already-terminal 409 (no double-revoke audit)', async () => {
      seed(repo, { status: ScopedSessionStatus.Revoked, revokedAt: new Date() });
      await expect(
        useCase.execute({ userId: 'u1', sessionId: 'session-abc-123', now: NOW }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect((await auditRepo.findByUserId('u1')).items).toHaveLength(0);
    });

    it('does NOT emit when the revoke race surfaces as 409', async () => {
      // Race window: findById sees active, then a concurrent revoke
      // flips the row before our repo.revoke runs → revoke returns
      // null → 409. Audit must not land for a no-op write.
      seed(repo);
      const revokeSpy = vi.spyOn(repo, 'revoke').mockResolvedValueOnce(null);
      await expect(
        useCase.execute({ userId: 'u1', sessionId: 'session-abc-123', now: NOW }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect((await auditRepo.findByUserId('u1')).items).toHaveLength(0);
      revokeSpy.mockRestore();
    });

    it('surfaces the audit-emission throw but leaves the mirror row revoked (documented trade)', async () => {
      // When repo.revoke succeeds but appendAudit.execute throws, the
      // mirror row is already in `revoked` terminal state. The use-case
      // must SURFACE the throw (the operator monitors 500s and the
      // dashboard's compliance view); operator runbook is "scan
      // agent_scoped_sessions for revoked rows lacking a paired
      // ScopedSessionRevoked row in agent_audit_events." Codifies the
      // JSDoc rationale (Code Reviewer M-3 + Security Engineer L-5
      // round 1).
      //
      // The asymmetry vs. mint (no conflict-on-retry to detect the
      // gap): a subsequent DELETE on the same sessionId hits the
      // "already terminal" 409 branch WITHOUT re-emitting the missed
      // audit row. Slice 3+ transactional-outbox work closes this gap.
      seed(repo);
      const auditSpy = vi
        .spyOn(auditRepo, 'append')
        .mockRejectedValueOnce(new Error('simulated audit-table outage'));
      await expect(
        useCase.execute({ userId: 'u1', sessionId: 'session-abc-123', now: NOW }),
      ).rejects.toThrow(/simulated audit-table outage/);
      const mirrorRow = await repo.findById('session-abc-123');
      expect(mirrorRow?.status).toBe(ScopedSessionStatus.Revoked);
      // Reality Checker MED-3 — pin the compensating control (orphan
      // log). A regression that drops the structured logger.error()
      // call would silently break the operator's reconciliation
      // runbook.
      expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          orphanMirrorRow: true,
          sessionId: 'session-abc-123',
          userId: 'u1',
          surface: Surface.MCP,
        }),
        expect.stringMatching(/orphan|reconcile/i),
      );
      auditSpy.mockRestore();
    });
  });
});
