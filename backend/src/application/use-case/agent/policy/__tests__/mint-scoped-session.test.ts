import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Audit-throw test path triggers `getLogger().error(...)` which lazily
// resolves the full env schema; seed the minimum required keys as a
// defense-in-depth in case the vi.mock below is bypassed by a future
// import order change. Mirrors `encrypt-shares-for-purchase.use-case.test.ts`.
beforeAll(() => {
  process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-chars-long';
});

// Reality Checker MED-3 pre-Codex: pin the compensating control
// (structured `orphanMirrorRow:true` log) load-bearingly. Without
// this mock + assertion, a regression that drops the structured log
// call from the audit-throw catch block would silently break the
// operator's grep-based reconciliation runbook with zero test
// signal. The `vi.hoisted` pattern is required because `vi.mock`
// factories run BEFORE the spy variable would otherwise be defined.
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

import { AgentUserState } from '../../../../../domain/agent/model/agent-user-state.js';
import { AuditEventType } from '../../../../../domain/agent/model/audit-event-type.enum.js';
import { Surface } from '../../../../../domain/agent/model/surface.enum.js';
import { Tier } from '../../../../../domain/agent/model/tier.enum.js';
import {
  MintScopedSessionConflictError,
  MintScopedSessionUseCase,
} from '../mint-scoped-session.use-case.js';
import { AppendAuditEventUseCase } from '../append-audit-event.use-case.js';
import { MemoryAgentAuditRepository } from '../../../../../infrastructure/repository/memory/memory-agent-audit.repository.js';
import { MemoryAgentStateRepository } from '../../../../../infrastructure/repository/memory/memory-agent-state.repository.js';
import { MemoryScopedSessionRepository } from '../../../../../infrastructure/repository/memory/memory-scoped-session.repository.js';
import type { MintScopedSessionDto } from '../../../../dto/agent/policy.dto.js';

const NOW = new Date('2026-05-22T12:00:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

const SUBSCRIPTION_ADDR = '0xCcCC000000000000000000000000000000000003';
const PURCHASE_SELECTOR = '0xdeadbeef';
const SIGNER = '0xAaAa000000000000000000000000000000000001';

function makeDto(overrides: Partial<MintScopedSessionDto['snapshot']> = {}): MintScopedSessionDto {
  return {
    surface: Surface.MCP,
    maxPerOpUsd6: '100000000',
    snapshot: {
      sessionId: 'session-abc-123',
      mode: 'scoped',
      signerAddress: SIGNER,
      targetContracts: [SUBSCRIPTION_ADDR],
      selectorCaps: [
        {
          selector: PURCHASE_SELECTOR,
          capArgIndex: 2,
          maxAmount: '1000000',
        },
      ],
      validUntilSec: NOW_SEC + 4 * 60 * 60, // 4h TTL
      mintedAtSec: NOW_SEC,
      ...overrides,
    },
  };
}

describe('MintScopedSessionUseCase', () => {
  let stateRepo: MemoryAgentStateRepository;
  let scopedRepo: MemoryScopedSessionRepository;
  let auditRepo: MemoryAgentAuditRepository;
  let appendAudit: AppendAuditEventUseCase;
  let useCase: MintScopedSessionUseCase;

  beforeEach(() => {
    stateRepo = new MemoryAgentStateRepository();
    scopedRepo = new MemoryScopedSessionRepository();
    auditRepo = new MemoryAgentAuditRepository();
    appendAudit = new AppendAuditEventUseCase(auditRepo);
    useCase = new MintScopedSessionUseCase(stateRepo, scopedRepo, appendAudit);
    loggerErrorSpy.mockClear();
  });

  async function seedTier(tier: Tier, userId = 'u1', surface: Surface = Surface.MCP): Promise<void> {
    await stateRepo.upsert(
      new AgentUserState({
        userId,
        surface,
        tier,
        pausedAt: null,
        pauseTrigger: null,
        pauseMetadata: null,
        enteredAt: NOW,
        validatorAddress: null,
        confirmedActionCount: 5,
        riskQuestionnaireComplete: true,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
  }

  it('happy path — mints + persists when user at Scoped tier', async () => {
    await seedTier(Tier.Scoped);
    const result = await useCase.execute({ userId: 'u1', dto: makeDto(), now: NOW });
    expect(result.session.sessionId).toBe('session-abc-123');
    expect(result.session.maxPerOpUsd6).toBe(100_000_000n);
    expect(result.session.signerAddress).toBe(SIGNER.toLowerCase());
    expect(result.session.targetContracts).toEqual([SUBSCRIPTION_ADDR.toLowerCase()]);
    expect(result.session.selectorCaps[0]?.selector).toBe(PURCHASE_SELECTOR);

    const persisted = await scopedRepo.findById('session-abc-123');
    expect(persisted).not.toBeNull();
    expect(persisted?.userId).toBe('u1');
  });

  it('rejects with 412 when no state row for surface', async () => {
    await expect(
      useCase.execute({ userId: 'u1', dto: makeDto(), now: NOW }),
    ).rejects.toMatchObject({
      statusCode: 412,
      name: 'ApplicationHttpError',
    });
  });

  it('rejects with 412 when state tier is PolicyBound (one step below Scoped)', async () => {
    await seedTier(Tier.PolicyBound);
    await expect(
      useCase.execute({ userId: 'u1', dto: makeDto(), now: NOW }),
    ).rejects.toThrow(/tier is policy-bound/);
  });

  it('rejects with 412 when state tier is Advisory', async () => {
    await seedTier(Tier.Advisory);
    await expect(
      useCase.execute({ userId: 'u1', dto: makeDto(), now: NOW }),
    ).rejects.toThrow(/tier is advisory/);
  });

  it('rejects with 409 when an active session for (user, surface) already exists', async () => {
    await seedTier(Tier.Scoped);
    await useCase.execute({ userId: 'u1', dto: makeDto(), now: NOW });
    const second = useCase.execute({
      userId: 'u1',
      dto: makeDto({ sessionId: 'session-abc-456' }),
      now: NOW,
    });
    await expect(second).rejects.toBeInstanceOf(MintScopedSessionConflictError);
    await expect(second).rejects.toMatchObject({
      statusCode: 409,
      existingSessionId: 'session-abc-123',
    });
  });

  it('allows re-mint when an existing active row has expired by time (Pickup A follow-up bug #10)', async () => {
    // Repro for the dedup-vs-expiry trap: the partial UNIQUE
    // `agent_scoped_sessions_user_surface_active_uq_v2` filters on
    // `status='active'` ONLY (no `valid_until_sec` predicate). Without
    // the opportunistic markExpired sweep at use-case step 2a, an
    // already-time-expired row would slip past `findLatestActive`
    // (which DOES filter on time) and then trip the DB unique
    // constraint at `scopedRepo.create` (23505). The operator hit
    // this on the Pickup A re-smoke 2026-05-22; the only recovery
    // was a manual `UPDATE` on prod DB.
    await seedTier(Tier.Scoped);

    // Seed an expired-but-status=active row directly into the repo
    // (mimics the on-disk state where the expiry-sweep cron hasn't
    // flipped status yet). Use the future-time clock to insert, then
    // jump forward past validUntilSec.
    const EARLY = new Date('2026-05-22T11:00:00.000Z');
    const EARLY_SEC = Math.floor(EARLY.getTime() / 1000);
    await useCase.execute({
      userId: 'u1',
      dto: makeDto({
        sessionId: 'expired-but-active',
        validUntilSec: EARLY_SEC + 300, // expires 5min after EARLY
        mintedAtSec: EARLY_SEC,
      }),
      now: EARLY,
    });

    // Now we're at NOW which is 1h past EARLY (= 55min past validUntilSec).
    const result = await useCase.execute({
      userId: 'u1',
      dto: makeDto({ sessionId: 'fresh-session', mintedAtSec: NOW_SEC }),
      now: NOW,
    });
    expect(result.session.sessionId).toBe('fresh-session');

    // The expired row should now be marked status='expired'.
    const expired = await scopedRepo.findById('expired-but-active');
    expect(expired?.status).toBe('expired');
    expect(expired?.expiredAt).toEqual(NOW);
  });

  it('rejects with 422 when validUntilSec is not in the future', async () => {
    await seedTier(Tier.Scoped);
    await expect(
      useCase.execute({
        userId: 'u1',
        dto: makeDto({ validUntilSec: NOW_SEC }),
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    // No-emit invariant — pre-validation rejections must NOT emit an
    // audit row (a future regression that moves the emit ahead of
    // the validity checks would poison the forensic chain with
    // phantom mints). Reality Checker MED-2 pre-Codex.
    expect((await auditRepo.findByUserId('u1')).items).toHaveLength(0);
  });

  it('rejects with 422 when mintedAtSec drifts > 5 min from server clock', async () => {
    await seedTier(Tier.Scoped);
    // 6 minutes ahead of server clock
    await expect(
      useCase.execute({
        userId: 'u1',
        dto: makeDto({ mintedAtSec: NOW_SEC + 6 * 60 }),
        now: NOW,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect((await auditRepo.findByUserId('u1')).items).toHaveLength(0);
  });

  it('accepts mintedAtSec within +5 min skew tolerance', async () => {
    await seedTier(Tier.Scoped);
    const result = await useCase.execute({
      userId: 'u1',
      dto: makeDto({ mintedAtSec: NOW_SEC + 4 * 60 }),
      now: NOW,
    });
    expect(result.session.mintedAtSec).toBe(NOW_SEC + 4 * 60);
  });

  it('accepts mintedAtSec within -5 min skew tolerance', async () => {
    await seedTier(Tier.Scoped);
    const result = await useCase.execute({
      userId: 'u1',
      dto: makeDto({ mintedAtSec: NOW_SEC - 4 * 60 }),
      now: NOW,
    });
    expect(result.session.mintedAtSec).toBe(NOW_SEC - 4 * 60);
  });

  it('lowercases signerAddress + targetContracts + permissionId during persist', async () => {
    await seedTier(Tier.Scoped);
    const result = await useCase.execute({
      userId: 'u1',
      dto: makeDto({
        signerAddress: '0xAAaABbBb0000000000000000000000000000000F',
        targetContracts: ['0xCcCcDdDd0000000000000000000000000000000E'],
        permissionId: '0xDeAdBeEf',
      }),
      now: NOW,
    });
    expect(result.session.signerAddress).toBe('0xaaaabbbb0000000000000000000000000000000f');
    expect(result.session.targetContracts).toEqual([
      '0xccccdddd0000000000000000000000000000000e',
    ]);
    expect(result.session.permissionId).toBe('0xdeadbeef');
  });

  it('stores totalSpentUsd6=0 on fresh mint regardless of dto input', async () => {
    await seedTier(Tier.Scoped);
    const result = await useCase.execute({ userId: 'u1', dto: makeDto(), now: NOW });
    expect(result.session.totalSpentUsd6).toBe(0n);
  });

  // ── Commit 2.B — audit emission (Security M-2 forensic chain) ──
  //
  // Strict assertions: without a positive check that the audit row
  // arrived at the repo, a future regression that drops the
  // appendAudit.execute call would silently pass every other test (the
  // mirror row still lands; only the forensic chain breaks).

  describe('audit emission (Commit 2.B)', () => {
    it('writes a ScopedSessionMinted row on the happy path', async () => {
      await seedTier(Tier.Scoped);
      await useCase.execute({ userId: 'u1', dto: makeDto(), now: NOW });

      const page = await auditRepo.findByUserId('u1');
      expect(page.items).toHaveLength(1);
      const event = page.items[0];
      expect(event.eventType).toBe(AuditEventType.ScopedSessionMinted);
      expect(event.surface).toBe(Surface.MCP);
      expect(event.userId).toBe('u1');
      expect(event.createdAt).toEqual(NOW);
      // Forensic-chain metadata invariants. `maxPerOpUsd6` is stringified
      // because BigInt isn't JSON-safe; the rest pass through.
      expect(event.metadata).toMatchObject({
        sessionId: 'session-abc-123',
        signerAddress: SIGNER.toLowerCase(),
        maxPerOpUsd6: '100000000',
        validUntilSec: NOW_SEC + 4 * 60 * 60,
        mintedAtSec: NOW_SEC,
      });
      // `consentActionHash` is OPTIONAL — only carried when the mint had
      // one. Default makeDto() omits it, so the metadata must NOT
      // include the key (vs. carrying `undefined` / `null`).
      expect(event.metadata).not.toHaveProperty('consentActionHash');
    });

    it('includes consentActionHash in metadata when the mint carried one (mixed-case → lowercase normalized)', async () => {
      await seedTier(Tier.Scoped);
      // Mixed-case input so the assertion below catches a regression
      // that drops the use-case's `.toLowerCase()` normalization
      // (Reality Checker LOW-1 pre-Codex). The Zod regex accepts
      // mixed case, so this shape is wire-legal.
      const mixedCaseHash =
        '0xFeEdFaCeFeEdFaCeFeEdFaCeFeEdFaCeFeEdFaCeFeEdFaCeFeEdFaCeFeEdFaCe';
      await useCase.execute({
        userId: 'u1',
        dto: makeDto({ consentActionHash: mixedCaseHash }),
        now: NOW,
      });

      const page = await auditRepo.findByUserId('u1');
      expect(page.items[0].metadata).toMatchObject({
        consentActionHash: mixedCaseHash.toLowerCase(),
      });
      // Strict-shape pin: the stored hash is fully lowercased,
      // matching the forensic-chain anchor shape on the consume side
      // (which always emits lowercase via `createHash().digest('hex')`).
      expect(
        (page.items[0].metadata as { consentActionHash: string }).consentActionHash,
      ).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('does NOT emit when the tier gate rejects (412 — no orphan audit row)', async () => {
      // No seedTier → state lookup returns null → 412 PreconditionFailed.
      // The audit row must not land for a refused mint, otherwise the
      // forensic chain carries spurious "minted" rows for sessions that
      // never persisted.
      await expect(
        useCase.execute({ userId: 'u1', dto: makeDto(), now: NOW }),
      ).rejects.toMatchObject({ statusCode: 412 });
      const page = await auditRepo.findByUserId('u1');
      expect(page.items).toHaveLength(0);
    });

    it('does NOT emit when the active-dedup gate rejects (409 — no double-emit)', async () => {
      await seedTier(Tier.Scoped);
      await useCase.execute({ userId: 'u1', dto: makeDto(), now: NOW });
      // First mint emitted; verify, then attempt a second mint that
      // collides on (user, surface). The second mint must throw 409 and
      // NOT emit a second audit row.
      const before = (await auditRepo.findByUserId('u1')).items.length;
      expect(before).toBe(1);

      const second = useCase.execute({
        userId: 'u1',
        dto: makeDto({ sessionId: 'session-abc-456' }),
        now: NOW,
      });
      await expect(second).rejects.toBeInstanceOf(MintScopedSessionConflictError);

      const after = (await auditRepo.findByUserId('u1')).items.length;
      expect(after).toBe(1);
    });

    it('does NOT emit when the mirror write throws (mint must abort the audit)', async () => {
      // If `scopedRepo.create` throws AFTER the dedup check passes (DB
      // outage, FK violation), the audit row must NOT land — otherwise
      // the chain carries a "minted" row for a session that doesn't
      // exist in the mirror. Mirror row + audit row are paired or
      // neither lands.
      await seedTier(Tier.Scoped);
      const createSpy = vi
        .spyOn(scopedRepo, 'create')
        .mockRejectedValueOnce(new Error('simulated DB outage'));
      await expect(
        useCase.execute({ userId: 'u1', dto: makeDto(), now: NOW }),
      ).rejects.toThrow(/simulated DB outage/);
      const page = await auditRepo.findByUserId('u1');
      expect(page.items).toHaveLength(0);
      createSpy.mockRestore();
    });

    it('surfaces the audit-emission throw but leaves the mirror row in place (documented trade)', async () => {
      // Inverse of the prior test: when scopedRepo.create succeeds but
      // appendAudit.execute throws (audit-table DB outage, JSON
      // serialization failure), the mirror row already landed. The
      // use-case must SURFACE the throw (so a 500 reaches the operator
      // dashboard / monitoring); operator runbook is "scan
      // agent_scoped_sessions for active rows lacking a paired
      // ScopedSessionMinted row in agent_audit_events and reconcile."
      // Codifies the JSDoc rationale (CR M-3 + SecEng L-5 round 1).
      await seedTier(Tier.Scoped);
      const auditSpy = vi
        .spyOn(auditRepo, 'append')
        .mockRejectedValueOnce(new Error('simulated audit-table outage'));
      await expect(
        useCase.execute({ userId: 'u1', dto: makeDto(), now: NOW }),
      ).rejects.toThrow(/simulated audit-table outage/);
      // Mirror row IS present (the throw fired AFTER scopedRepo.create
      // landed). The forensic-chain gap is the documented trade-off.
      const mirrorRow = await scopedRepo.findById('session-abc-123');
      expect(mirrorRow).not.toBeNull();
      expect(mirrorRow?.userId).toBe('u1');
      // Reality Checker MED-3 — pin the compensating control. The
      // structured `orphanMirrorRow:true` log is the operator's
      // PRIMARY surface for orphan detection until the Slice 3+
      // reconciliation cron lands; a regression that drops this
      // logger.error() call would silently break the runbook's grep
      // target with no other test signal.
      expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          orphanMirrorRow: true,
          sessionId: 'session-abc-123',
          userId: 'u1',
          surface: Surface.MCP,
        }),
        expect.stringMatching(/orphaned/),
      );
      auditSpy.mockRestore();
    });
  });
});
