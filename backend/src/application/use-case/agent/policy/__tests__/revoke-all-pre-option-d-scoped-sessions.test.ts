import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

beforeAll(() => {
  process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-chars-long';
});

const { loggerErrorSpy, loggerInfoSpy, loggerWarnSpy } = vi.hoisted(() => ({
  loggerErrorSpy: vi.fn(),
  loggerInfoSpy: vi.fn(),
  loggerWarnSpy: vi.fn(),
}));
vi.mock('../../../../../core/logger.js', () => ({
  getLogger: (_name?: string) => ({
    error: loggerErrorSpy,
    info: loggerInfoSpy,
    warn: loggerWarnSpy,
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => ({
      error: loggerErrorSpy,
      info: loggerInfoSpy,
      warn: loggerWarnSpy,
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
import {
  RevokeAllPreOptionDScopedSessionsUseCase,
  OptionDC1MigrationPartialFailureError,
  OPTION_D_C1_PARTIAL_FAILURE_CODE,
} from '../revoke-all-pre-option-d-scoped-sessions.use-case.js';

const NOW = new Date('2026-05-23T18:30:00.000Z');

async function findAuditsFor(
  repo: MemoryAgentAuditRepository,
  userId: string,
): Promise<ReadonlyArray<{ eventType: string; metadata: unknown }>> {
  // `MemoryAgentAuditRepository.findByUserId` returns
  // `PaginatedAuditEvents` (items + cursor). Tests only need the
  // items array; flatten via this helper so the call sites stay
  // readable.
  const page = await repo.findByUserId(userId, { limit: 100 });
  return page.items;
}

function seed(
  repo: MemoryScopedSessionRepository,
  overrides: Partial<ConstructorParameters<typeof ScopedSession>[0]> = {},
): ScopedSession {
  const session = new ScopedSession({
    sessionId: overrides.sessionId ?? 'sess-pre-d1-001',
    userId: 'user-A',
    surface: Surface.MCP,
    status: ScopedSessionStatus.Active,
    signerAddress: '0xaaaa000000000000000000000000000000000001',
    permissionId: '0xa7bfdd5c',
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

describe('RevokeAllPreOptionDScopedSessionsUseCase', () => {
  let repo: MemoryScopedSessionRepository;
  let auditRepo: MemoryAgentAuditRepository;
  let appendAudit: AppendAuditEventUseCase;
  let useCase: RevokeAllPreOptionDScopedSessionsUseCase;

  beforeEach(() => {
    repo = new MemoryScopedSessionRepository();
    auditRepo = new MemoryAgentAuditRepository();
    appendAudit = new AppendAuditEventUseCase(auditRepo);
    useCase = new RevokeAllPreOptionDScopedSessionsUseCase(repo, appendAudit);
    loggerErrorSpy.mockClear();
    loggerInfoSpy.mockClear();
    loggerWarnSpy.mockClear();
  });

  it('returns zero-count result when no active sessions exist (idempotent no-op)', async () => {
    const result = await useCase.execute({ now: NOW });
    expect(result.revokedCount).toBe(0);
    expect(result.auditEmissionFailures).toBe(0);
    expect(result.orphanedSessionIds).toEqual([]);
    expect(result.appliedAt).toEqual(NOW);

    const audits = await findAuditsFor(auditRepo,'user-A');
    expect(audits).toHaveLength(0);
  });

  it('flips all active sessions to revoked + emits paired audit rows', async () => {
    seed(repo, { sessionId: 'sess-1', userId: 'user-A' });
    seed(repo, { sessionId: 'sess-2', userId: 'user-B' });

    const result = await useCase.execute({ now: NOW });
    expect(result.revokedCount).toBe(2);
    expect(result.auditEmissionFailures).toBe(0);

    const s1 = await repo.findById('sess-1');
    const s2 = await repo.findById('sess-2');
    expect(s1?.status).toBe(ScopedSessionStatus.Revoked);
    expect(s2?.status).toBe(ScopedSessionStatus.Revoked);
    expect(s1?.revokedAt).toEqual(NOW);
    expect(s2?.revokedAt).toEqual(NOW);

    const audits = [
      ...(await findAuditsFor(auditRepo,'user-A')),
      ...(await findAuditsFor(auditRepo,'user-B')),
    ];
    const migrationAudits = audits.filter(
      (a) => a.eventType === AuditEventType.ScopedSessionRevokedByPolicyMigration,
    );
    expect(migrationAudits).toHaveLength(2);
  });

  it('audit metadata captures forensic anchors (sessionId, signer, permissionId, reason)', async () => {
    seed(repo, {
      sessionId: 'sess-forensic',
      userId: 'user-F',
      signerAddress: '0xcccc000000000000000000000000000000000099',
      permissionId: '0xfeedface',
    });

    await useCase.execute({ now: NOW });
    const audits = await findAuditsFor(auditRepo,'user-F');
    expect(audits).toHaveLength(1);
    const row = audits[0]!;
    expect(row.eventType).toBe(AuditEventType.ScopedSessionRevokedByPolicyMigration);
    expect(row.metadata).toMatchObject({
      sessionId: 'sess-forensic',
      signerAddress: '0xcccc000000000000000000000000000000000099',
      permissionId: '0xfeedface',
      reason: 'option_d_c1_callpolicy_widening',
      revokedAt: NOW.toISOString(),
    });
  });

  it('honors a custom reason override (operator-supplied)', async () => {
    seed(repo);
    await useCase.execute({ now: NOW, reason: 'option_d_dry_run_2026_05_23' });
    const audits = await findAuditsFor(auditRepo,'user-A');
    expect(audits[0]!.metadata).toMatchObject({
      reason: 'option_d_dry_run_2026_05_23',
    });
  });

  it('idempotency — re-running on already-revoked rows is a no-op (zero new audits)', async () => {
    seed(repo);
    await useCase.execute({ now: NOW });
    const firstAudits = await findAuditsFor(auditRepo,'user-A');
    expect(firstAudits).toHaveLength(1);

    // Run again — nothing active, no new audits.
    const secondResult = await useCase.execute({ now: NOW });
    expect(secondResult.revokedCount).toBe(0);

    const secondAudits = await findAuditsFor(auditRepo,'user-A');
    expect(secondAudits).toHaveLength(1);
  });

  it('skips audit emission for orphaned-user rows (userId NULL) but still flips status', async () => {
    // FK CASCADE SET NULL — user deletion preserved the forensic row
    // but userId is null. Audit emission requires a userId; the
    // use-case must NOT silently skip + must NOT crash.
    seed(repo, { sessionId: 'sess-orphan', userId: null });
    seed(repo, { sessionId: 'sess-live', userId: 'user-A' });

    const result = await useCase.execute({ now: NOW });
    expect(result.revokedCount).toBe(2);
    expect(result.auditEmissionFailures).toBe(0);

    expect((await repo.findById('sess-orphan'))?.status).toBe(
      ScopedSessionStatus.Revoked,
    );
    expect((await repo.findById('sess-live'))?.status).toBe(
      ScopedSessionStatus.Revoked,
    );

    // Audit emitted only for the live row; orphan was logged as warn.
    expect(await findAuditsFor(auditRepo,'user-A')).toHaveLength(1);
    expect(loggerWarnSpy).toHaveBeenCalled();

    // CR-MED-4 + BA orphan (multi-agent review 2026-05-23) — the
    // orphan sessionIds MUST surface in the result so the operator
    // sees the count without grepping homelab logs.
    expect(result.skippedOrphanedUserIds).toEqual(['sess-orphan']);
    expect(result.orphanedSessionIds).toEqual([]);

    // SecEng-MED-2 — the orphan-user log MUST NOT include
    // `signerAddress` (correlation between user-id and on-chain
    // pseudonym across log shipping).
    const warnArgs = loggerWarnSpy.mock.calls.map((c) => c[0]);
    for (const arg of warnArgs) {
      if (arg && typeof arg === 'object' && 'sessionId' in (arg as object)) {
        expect(arg).not.toHaveProperty('signerAddress');
      }
    }
  });

  it('does NOT touch terminal rows (revoked + expired stay terminal)', async () => {
    seed(repo, {
      sessionId: 'sess-already-revoked',
      status: ScopedSessionStatus.Revoked,
      revokedAt: new Date('2026-05-20T00:00:00.000Z'),
    });
    seed(repo, {
      sessionId: 'sess-already-expired',
      status: ScopedSessionStatus.Expired,
      expiredAt: new Date('2026-05-20T00:00:00.000Z'),
    });
    seed(repo, { sessionId: 'sess-active', userId: 'user-A' });

    const result = await useCase.execute({ now: NOW });
    expect(result.revokedCount).toBe(1);

    // Pre-existing revoked row's revoked_at should be preserved, not
    // overwritten to NOW.
    const preRevoked = await repo.findById('sess-already-revoked');
    expect(preRevoked?.revokedAt).toEqual(new Date('2026-05-20T00:00:00.000Z'));
  });

  it('partial-failure surface — emission throw flags orphan + re-throws aggregate', async () => {
    seed(repo, { sessionId: 'sess-good', userId: 'user-A' });
    seed(repo, { sessionId: 'sess-throws', userId: 'user-B' });

    // Wrap the use-case's `appendAudit` collaborator so the second
    // call throws. The use-case iterates `affected` and emits one
    // audit row per row; iteration order in the memory repo is
    // insertion-order (per `Map` iteration semantics) — so `sess-good`
    // emits first, `sess-throws` second.
    const realExecute = appendAudit.execute.bind(appendAudit);
    let callCount = 0;
    vi.spyOn(appendAudit, 'execute').mockImplementation(async (input) => {
      callCount += 1;
      if (callCount === 2) {
        throw new Error('audit-emit failure for testing');
      }
      return realExecute(input);
    });

    // BA-MED-8 (multi-agent review 2026-05-23) — verify the
    // dedicated error class + `code` discriminator so downstream
    // tooling can branch on `err instanceof
    // OptionDC1MigrationPartialFailureError` AND `err.code ===
    // OPTION_D_C1_PARTIAL_FAILURE_CODE`.
    const thrown = await useCase.execute({ now: NOW }).then(
      () => {
        throw new Error('useCase.execute should have rejected');
      },
      (e) => e as unknown,
    );
    expect(thrown).toBeInstanceOf(OptionDC1MigrationPartialFailureError);
    expect((thrown as OptionDC1MigrationPartialFailureError).code).toBe(
      OPTION_D_C1_PARTIAL_FAILURE_CODE,
    );
    expect((thrown as OptionDC1MigrationPartialFailureError).message).toMatch(
      /1 of 2 audit emissions failed/,
    );
    expect(
      (thrown as OptionDC1MigrationPartialFailureError).partialResult
        .auditEmissionFailures,
    ).toBe(1);

    // Both rows were still flipped (bulk update is atomic).
    expect((await repo.findById('sess-good'))?.status).toBe(
      ScopedSessionStatus.Revoked,
    );
    expect((await repo.findById('sess-throws'))?.status).toBe(
      ScopedSessionStatus.Revoked,
    );
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ orphanMirrorRow: true }),
      expect.stringMatching(/audit emission failed/i),
    );

    // SecEng-MED-2 — the orphan-emission log must NOT carry
    // `signerAddress` (cross-log correlation defense).
    const errArgs = loggerErrorSpy.mock.calls.map((c) => c[0]);
    for (const arg of errArgs) {
      if (
        arg &&
        typeof arg === 'object' &&
        'orphanMirrorRow' in (arg as object)
      ) {
        expect(arg).not.toHaveProperty('signerAddress');
      }
    }
  });

  it('mintedBeforeSec filter narrows audit emission (CR-MED-3 / BA-MED-5)', async () => {
    // Two rows: one minted PRE-cutoff, one minted POST-cutoff.
    // The bulk UPDATE still flips both (single statement, atomic),
    // but the use-case's audit-emission loop honors the cutoff so
    // the canonical migration audit row is only emitted for the
    // pre-cutoff row. The post-cutoff row gets a generic audit pair
    // via the next routine sweep — out of scope for this test.
    seed(repo, {
      sessionId: 'sess-pre-cutoff',
      userId: 'user-A',
      mintedAtSec: 1_000_000_000,
    });
    seed(repo, {
      sessionId: 'sess-post-cutoff',
      userId: 'user-B',
      mintedAtSec: 1_000_001_000,
    });

    const result = await useCase.execute({
      now: NOW,
      mintedBeforeSec: 1_000_000_500,
    });

    // Both rows flipped by the bulk UPDATE (single SQL statement).
    expect(result.revokedCount).toBe(2);
    expect((await repo.findById('sess-pre-cutoff'))?.status).toBe(
      ScopedSessionStatus.Revoked,
    );
    expect((await repo.findById('sess-post-cutoff'))?.status).toBe(
      ScopedSessionStatus.Revoked,
    );
    // A warn-log is emitted so the operator notices the cross-cutoff
    // skip — load-bearing per the use-case JSDoc.
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mintedBeforeSec: 1_000_000_500,
        skippedPostCutoffCount: 1,
      }),
      expect.stringMatching(/newer than `mintedBeforeSec`/),
    );
  });

  it('appliedAt is the injected `now` (test injection works through both layers)', async () => {
    const customNow = new Date('2099-01-01T00:00:00.000Z');
    seed(repo);
    const result = await useCase.execute({ now: customNow });
    expect(result.appliedAt).toEqual(customNow);
    const reloaded = await repo.findById('sess-pre-d1-001');
    expect(reloaded?.revokedAt).toEqual(customNow);
  });
});
