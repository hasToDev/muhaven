import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

beforeAll(() => {
  process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-chars-long';
});

const { loggerErrorSpy, loggerWarnSpy } = vi.hoisted(() => ({
  loggerErrorSpy: vi.fn(),
  loggerWarnSpy: vi.fn(),
}));
vi.mock('../../../../../core/logger.js', () => ({
  getLogger: (_name?: string) => ({
    error: loggerErrorSpy,
    info: vi.fn(),
    warn: loggerWarnSpy,
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => ({
      error: loggerErrorSpy,
      info: vi.fn(),
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
import { MarkScopedSessionValidatorEnabledUseCase } from '../mark-scoped-session-validator-enabled.use-case.js';
import { ApplicationHttpError } from '../../../../../core/errors.js';

const NOW = new Date('2026-05-23T22:00:00.000Z');
const TX_HASH = '0xabcd000000000000000000000000000000000000000000000000000000001111' as `0x${string}`;
const PERMISSION_ID = '0xa2500760' as `0x${string}`;

function seed(
  repo: MemoryScopedSessionRepository,
  overrides: Partial<ConstructorParameters<typeof ScopedSession>[0]> = {},
): ScopedSession {
  const session = new ScopedSession({
    sessionId: 'sess-c3-001',
    userId: 'u1',
    surface: Surface.MCP,
    status: ScopedSessionStatus.Active,
    signerAddress: '0x38e018e95ead91bb9d91590d3856c2f324d5c3bd',
    permissionId: PERMISSION_ID,
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
    enableStatus: 'pending',
    validatorEnabledAt: null,
    validatorEnabledTxHash: null,
    validatorNonce: 1,
    ...overrides,
  });
  void repo.create(session);
  return session;
}

describe('MarkScopedSessionValidatorEnabledUseCase', () => {
  let repo: MemoryScopedSessionRepository;
  let auditRepo: MemoryAgentAuditRepository;
  let appendAudit: AppendAuditEventUseCase;
  let useCase: MarkScopedSessionValidatorEnabledUseCase;

  beforeEach(() => {
    repo = new MemoryScopedSessionRepository();
    auditRepo = new MemoryAgentAuditRepository();
    appendAudit = new AppendAuditEventUseCase(auditRepo);
    useCase = new MarkScopedSessionValidatorEnabledUseCase(repo, appendAudit);
    loggerErrorSpy.mockReset();
    loggerWarnSpy.mockReset();
  });

  it('flips a pending row to enabled + emits ValidatorInstalled audit', async () => {
    seed(repo);
    const result = await useCase.execute({
      sessionId: 'sess-c3-001',
      txHash: TX_HASH,
      blockNumber: 12345,
      logIndex: 0,
      source: 'chain_indexer',
      now: NOW,
    });
    expect(result.flipped).toBe(true);
    expect(result.session.enableStatus).toBe('enabled');
    expect(result.session.validatorEnabledAt).toEqual(NOW);
    expect(result.session.validatorEnabledTxHash).toBe(TX_HASH);

    const audits = await auditRepo.findByUserId('u1', { limit: 10 });
    expect(audits.items).toHaveLength(1);
    expect(audits.items[0]!.eventType).toBe(AuditEventType.ValidatorInstalled);
    expect(audits.items[0]!.metadata).toMatchObject({
      sessionId: 'sess-c3-001',
      permissionId: PERMISSION_ID,
      source: 'chain_indexer',
    });
  });

  it('idempotent on already-enabled row (returns flipped=false, no new audit)', async () => {
    seed(repo, {
      enableStatus: 'enabled',
      validatorEnabledAt: new Date('2026-05-23T21:00:00.000Z'),
      validatorEnabledTxHash: TX_HASH,
    });
    const result = await useCase.execute({
      sessionId: 'sess-c3-001',
      txHash: TX_HASH,
      blockNumber: 12345,
      logIndex: 0,
      source: 'broker_callback',
    });
    expect(result.flipped).toBe(false);
    expect(result.session.enableStatus).toBe('enabled');
    const audits = await auditRepo.findByUserId('u1', { limit: 10 });
    expect(audits.items).toHaveLength(0);
  });

  it('throws 409 when row is in failed state', async () => {
    seed(repo, { enableStatus: 'failed' });
    await expect(
      useCase.execute({
        sessionId: 'sess-c3-001',
        txHash: TX_HASH,
        blockNumber: 12345,
        logIndex: 0,
        source: 'broker_callback',
      }),
    ).rejects.toThrow(ApplicationHttpError);
  });

  it('throws 404 when row has no install material (pre-C2)', async () => {
    seed(repo, { enableStatus: null });
    await expect(
      useCase.execute({
        sessionId: 'sess-c3-001',
        txHash: TX_HASH,
        blockNumber: 12345,
        logIndex: 0,
        source: 'broker_callback',
      }),
    ).rejects.toThrow(/no install material/);
  });

  it('throws 404 when session does not exist', async () => {
    await expect(
      useCase.execute({
        sessionId: 'sess-missing',
        txHash: TX_HASH,
        blockNumber: 12345,
        logIndex: 0,
        source: 'chain_indexer',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('logs orphan + skips audit when userId is null (CASCADE-orphaned row)', async () => {
    seed(repo, { userId: null });
    const result = await useCase.execute({
      sessionId: 'sess-c3-001',
      txHash: TX_HASH,
      blockNumber: 12345,
      logIndex: 0,
      source: 'chain_indexer',
      now: NOW,
    });
    expect(result.flipped).toBe(true);
    expect(result.session.enableStatus).toBe('enabled');
    // Orphan path skips audit entirely — there's no userId to query by;
    // verify by checking the audit repo's underlying store is empty.
    const auditsForU1 = await auditRepo.findByUserId('u1', { limit: 10 });
    expect(auditsForU1.items).toHaveLength(0);
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ orphanMirrorRow: true }),
      expect.stringContaining('orphaned session row'),
    );
  });

  it('logs orphan when audit emission throws (mirror row still flipped)', async () => {
    seed(repo);
    const throwingAudit = {
      execute: vi.fn().mockRejectedValue(new Error('audit append blew up')),
    } as unknown as AppendAuditEventUseCase;
    const ucWithThrowingAudit = new MarkScopedSessionValidatorEnabledUseCase(
      repo,
      throwingAudit,
    );
    const result = await ucWithThrowingAudit.execute({
      sessionId: 'sess-c3-001',
      txHash: TX_HASH,
      blockNumber: 12345,
      logIndex: 0,
      source: 'chain_indexer',
      now: NOW,
    });
    expect(result.flipped).toBe(true);
    expect(result.session.enableStatus).toBe('enabled');
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ orphanMirrorRow: true }),
      expect.stringContaining('audit emission failed'),
    );
  });

  it('lowercases the txHash before persisting', async () => {
    seed(repo);
    const upperHash = TX_HASH.toUpperCase().replace(/^0X/, '0x') as `0x${string}`;
    const result = await useCase.execute({
      sessionId: 'sess-c3-001',
      txHash: upperHash,
      blockNumber: 12345,
      logIndex: 0,
      source: 'chain_indexer',
    });
    expect(result.session.validatorEnabledTxHash).toBe(TX_HASH);
  });
});
