import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

beforeAll(() => {
  process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-chars-long';
});

import { AuditEventType } from '../../../domain/agent/model/audit-event-type.enum.js';
import { ScopedSession } from '../../../domain/agent/model/scoped-session.js';
import { ScopedSessionStatus } from '../../../domain/agent/model/scoped-session-status.enum.js';
import { Surface } from '../../../domain/agent/model/surface.enum.js';
import { AppendAuditEventUseCase } from '../../../application/use-case/agent/policy/append-audit-event.use-case.js';
import { MemoryAgentAuditRepository } from '../../repository/memory/memory-agent-audit.repository.js';
import { MemoryScopedSessionRepository } from '../../repository/memory/memory-scoped-session.repository.js';
import { ValidatorEnableWatchdog } from '../validator-enable-watchdog.js';
import type {
  IOperatorAlertTransport,
  OperatorAlertPayload,
} from '../../operator/operator-alert-transport.js';

class StubAlertTransport implements IOperatorAlertTransport {
  sent: OperatorAlertPayload[] = [];
  shouldThrow = false;
  async notify(payload: OperatorAlertPayload): Promise<void> {
    if (this.shouldThrow) throw new Error('alert transport down');
    this.sent.push(payload);
  }
}

function seed(
  repo: MemoryScopedSessionRepository,
  overrides: Partial<ConstructorParameters<typeof ScopedSession>[0]> = {},
): ScopedSession {
  const session = new ScopedSession({
    sessionId: 'sess-watchdog-1',
    userId: 'u1',
    surface: Surface.MCP,
    status: ScopedSessionStatus.Active,
    signerAddress: '0x38e018e95ead91bb9d91590d3856c2f324d5c3bd',
    permissionId: '0xa2500760',
    targetContracts: ['0xbbbb000000000000000000000000000000000002'],
    selectorCaps: [{ selector: '0xdeadbeef', capArgIndex: 2, maxAmount: '1000000' }],
    maxPerOpUsd6: 100_000_000n,
    totalSpentUsd6: 0n,
    validUntilSec: 2_000_000_000,
    mintedAtSec: 1_000_000_000,
    consentActionHash: null,
    consentTextSha256: null,
    mintedAt: new Date('2026-05-23T20:00:00.000Z'),
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

describe('ValidatorEnableWatchdog', () => {
  let repo: MemoryScopedSessionRepository;
  let alert: StubAlertTransport;
  let auditRepo: MemoryAgentAuditRepository;
  let appendAudit: AppendAuditEventUseCase;
  let watchdog: ValidatorEnableWatchdog;

  beforeEach(() => {
    repo = new MemoryScopedSessionRepository();
    alert = new StubAlertTransport();
    auditRepo = new MemoryAgentAuditRepository();
    appendAudit = new AppendAuditEventUseCase(auditRepo);
    watchdog = new ValidatorEnableWatchdog(repo, alert, appendAudit, {
      staleThresholdSec: 720, // 12 minutes
      batchLimit: 10,
    });
  });

  it('flips stale pending rows to failed + fires one alert per row', async () => {
    seed(repo, { sessionId: 'stale-1', mintedAt: new Date('2026-05-23T20:00:00.000Z') });
    seed(repo, {
      sessionId: 'stale-2',
      userId: 'u2',
      mintedAt: new Date('2026-05-23T20:05:00.000Z'),
    });
    const result = await watchdog.tickOnce(new Date('2026-05-23T20:30:00.000Z'));
    expect(result.flipped).toBe(2);
    const r1 = await repo.findById('stale-1');
    const r2 = await repo.findById('stale-2');
    expect(r1?.enableStatus).toBe('failed');
    expect(r2?.enableStatus).toBe('failed');
    expect(alert.sent).toHaveLength(2);
    expect(alert.sent[0]!.severity).toBe('warn');
    expect(alert.sent[0]!.errorClass).toBe('ValidatorInstallTimeout');
  });

  it('skips rows younger than the stale threshold', async () => {
    seed(repo, {
      sessionId: 'fresh',
      mintedAt: new Date('2026-05-23T20:28:00.000Z'),
    });
    const result = await watchdog.tickOnce(new Date('2026-05-23T20:30:00.000Z'));
    expect(result.flipped).toBe(0);
    const row = await repo.findById('fresh');
    expect(row?.enableStatus).toBe('pending');
    expect(alert.sent).toHaveLength(0);
  });

  it('skips rows already in enabled / failed state', async () => {
    seed(repo, {
      sessionId: 'already-enabled',
      enableStatus: 'enabled',
      validatorEnabledAt: new Date('2026-05-23T20:01:00.000Z'),
      validatorEnabledTxHash: '0xabcd000000000000000000000000000000000000000000000000000000001111',
    });
    seed(repo, {
      sessionId: 'already-failed',
      userId: 'u2',
      enableStatus: 'failed',
    });
    const result = await watchdog.tickOnce(new Date('2026-05-23T20:30:00.000Z'));
    expect(result.flipped).toBe(0);
    expect(alert.sent).toHaveLength(0);
  });

  it('continues even when alert transport throws', async () => {
    alert.shouldThrow = true;
    seed(repo, { sessionId: 'stale-with-bad-alert' });
    const result = await watchdog.tickOnce(new Date('2026-05-23T20:30:00.000Z'));
    expect(result.flipped).toBe(1);
    const row = await repo.findById('stale-with-bad-alert');
    expect(row?.enableStatus).toBe('failed');
  });

  it('emits ValidatorInstallFailed audit per flipped row', async () => {
    seed(repo, { sessionId: 'audited-1' });
    seed(repo, { sessionId: 'audited-2', userId: 'u2' });
    const result = await watchdog.tickOnce(new Date('2026-05-23T20:30:00.000Z'));
    expect(result.flipped).toBe(2);
    const u1Audits = await auditRepo.findByUserId('u1', { limit: 10 });
    const u2Audits = await auditRepo.findByUserId('u2', { limit: 10 });
    expect(u1Audits.items).toHaveLength(1);
    expect(u2Audits.items).toHaveLength(1);
    expect(u1Audits.items[0]!.eventType).toBe(AuditEventType.ValidatorInstallFailed);
    expect(u1Audits.items[0]!.metadata).toMatchObject({
      sessionId: 'audited-1',
      source: 'watchdog',
    });
  });

  it('skips audit emission for orphaned rows (userId=null)', async () => {
    seed(repo, { sessionId: 'orphan', userId: null });
    const result = await watchdog.tickOnce(new Date('2026-05-23T20:30:00.000Z'));
    expect(result.flipped).toBe(1);
    const audits = await auditRepo.findByUserId('u1', { limit: 10 });
    expect(audits.items).toHaveLength(0);
  });

  it('respects batchLimit', async () => {
    for (let i = 0; i < 5; i++) {
      seed(repo, {
        sessionId: `bulk-${i}`,
        userId: `u${i}`,
        mintedAt: new Date(`2026-05-23T20:0${i}:00.000Z`),
      });
    }
    const limited = new ValidatorEnableWatchdog(repo, alert, appendAudit, {
      staleThresholdSec: 720,
      batchLimit: 2,
    });
    const result = await limited.tickOnce(new Date('2026-05-23T20:30:00.000Z'));
    expect(result.flipped).toBe(2);
    // Oldest two flipped first (FIFO).
    const r0 = await repo.findById('bulk-0');
    const r1 = await repo.findById('bulk-1');
    const r2 = await repo.findById('bulk-2');
    expect(r0?.enableStatus).toBe('failed');
    expect(r1?.enableStatus).toBe('failed');
    expect(r2?.enableStatus).toBe('pending');
  });

  it('re-entrant guard prevents overlapping ticks', async () => {
    seed(repo);
    const t1 = watchdog.tickOnce(new Date('2026-05-23T20:30:00.000Z'));
    const t2 = watchdog.tickOnce(new Date('2026-05-23T20:30:00.000Z'));
    const [r1, r2] = await Promise.all([t1, t2]);
    // First wins with the flip, second sees `running=true` and returns
    // immediately. The actual flip count is 1.
    const totalFlipped = r1.flipped + r2.flipped;
    expect(totalFlipped).toBe(1);
  });
});
