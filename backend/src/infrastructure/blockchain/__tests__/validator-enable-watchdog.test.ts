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

// Fixed clock for the suite. The watchdog's TTL-based trigger flags a
// pending session iff `validUntilSec <= nowSec - graceSec`.
const NOW = new Date('2026-05-23T20:30:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const GRACE_SEC = 720;
// Expired well past the grace window → flagged.
const EXPIRED_VALID_UNTIL = NOW_SEC - 1000;
// Still within its 8h TTL (expires in 1h) → NOT flagged (the bug fix:
// a within-TTL pending session is just awaiting its first Path D buy).
const FUTURE_VALID_UNTIL = NOW_SEC + 3600;
// Expired, but still inside the post-expiry grace buffer → NOT flagged.
const IN_GRACE_VALID_UNTIL = NOW_SEC - 300;

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
    // Default: expired past grace → flagged. Skip-tests override with
    // FUTURE_VALID_UNTIL / IN_GRACE_VALID_UNTIL.
    validUntilSec: EXPIRED_VALID_UNTIL,
    mintedAtSec: 1_000_000_000,
    consentActionHash: null,
    consentTextSha256: null,
    mintedAt: new Date('2026-05-23T12:00:00.000Z'),
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

  it('flips expired pending rows to failed + fires one alert per row', async () => {
    seed(repo, { sessionId: 'expired-1', validUntilSec: EXPIRED_VALID_UNTIL });
    seed(repo, {
      sessionId: 'expired-2',
      userId: 'u2',
      validUntilSec: EXPIRED_VALID_UNTIL - 500,
    });
    const result = await watchdog.tickOnce(NOW);
    expect(result.flipped).toBe(2);
    const r1 = await repo.findById('expired-1');
    const r2 = await repo.findById('expired-2');
    expect(r1?.enableStatus).toBe('failed');
    expect(r2?.enableStatus).toBe('failed');
    expect(alert.sent).toHaveLength(2);
    expect(alert.sent[0]!.severity).toBe('warn');
    expect(alert.sent[0]!.errorClass).toBe('ValidatorInstallExpired');
  });

  // THE BUG-FIX REGRESSION: a within-TTL pending session is just
  // awaiting its first Path D buy — the watchdog MUST NOT flag it.
  // (The old mint-age trigger flipped it after 12min, killing healthy
  // sessions before the user ever bought — surfaced in the first prod
  // smoke when session 837c6a98 was killed ~12min after mint.)
  it('does NOT flag within-TTL pending rows (awaiting first buy)', async () => {
    seed(repo, { sessionId: 'within-ttl', validUntilSec: FUTURE_VALID_UNTIL });
    const result = await watchdog.tickOnce(NOW);
    expect(result.flipped).toBe(0);
    const row = await repo.findById('within-ttl');
    expect(row?.enableStatus).toBe('pending');
    expect(alert.sent).toHaveLength(0);
  });

  it('does NOT flag rows still inside the post-expiry grace window', async () => {
    seed(repo, { sessionId: 'in-grace', validUntilSec: IN_GRACE_VALID_UNTIL });
    const result = await watchdog.tickOnce(NOW);
    expect(result.flipped).toBe(0);
    const row = await repo.findById('in-grace');
    expect(row?.enableStatus).toBe('pending');
  });

  it('skips rows already in enabled / failed state (even if expired)', async () => {
    seed(repo, {
      sessionId: 'already-enabled',
      enableStatus: 'enabled',
      validUntilSec: EXPIRED_VALID_UNTIL,
      validatorEnabledAt: new Date('2026-05-23T19:01:00.000Z'),
      validatorEnabledTxHash: '0xabcd000000000000000000000000000000000000000000000000000000001111',
    });
    seed(repo, {
      sessionId: 'already-failed',
      userId: 'u2',
      enableStatus: 'failed',
      validUntilSec: EXPIRED_VALID_UNTIL,
    });
    const result = await watchdog.tickOnce(NOW);
    expect(result.flipped).toBe(0);
    expect(alert.sent).toHaveLength(0);
  });

  it('continues even when alert transport throws', async () => {
    alert.shouldThrow = true;
    seed(repo, { sessionId: 'expired-with-bad-alert', validUntilSec: EXPIRED_VALID_UNTIL });
    const result = await watchdog.tickOnce(NOW);
    expect(result.flipped).toBe(1);
    const row = await repo.findById('expired-with-bad-alert');
    expect(row?.enableStatus).toBe('failed');
  });

  it('emits ValidatorInstallFailed audit per flipped row', async () => {
    seed(repo, { sessionId: 'audited-1', validUntilSec: EXPIRED_VALID_UNTIL });
    seed(repo, { sessionId: 'audited-2', userId: 'u2', validUntilSec: EXPIRED_VALID_UNTIL });
    const result = await watchdog.tickOnce(NOW);
    expect(result.flipped).toBe(2);
    const u1Audits = await auditRepo.findByUserId('u1', { limit: 10 });
    const u2Audits = await auditRepo.findByUserId('u2', { limit: 10 });
    expect(u1Audits.items).toHaveLength(1);
    expect(u2Audits.items).toHaveLength(1);
    expect(u1Audits.items[0]!.eventType).toBe(AuditEventType.ValidatorInstallFailed);
    expect(u1Audits.items[0]!.metadata).toMatchObject({
      sessionId: 'audited-1',
      source: 'watchdog',
      reason: 'ttl_expired_without_install',
    });
  });

  it('skips audit emission for orphaned rows (userId=null)', async () => {
    seed(repo, { sessionId: 'orphan', userId: null, validUntilSec: EXPIRED_VALID_UNTIL });
    const result = await watchdog.tickOnce(NOW);
    expect(result.flipped).toBe(1);
    const audits = await auditRepo.findByUserId('u1', { limit: 10 });
    expect(audits.items).toHaveLength(0);
  });

  it('respects batchLimit', async () => {
    for (let i = 0; i < 5; i++) {
      seed(repo, {
        sessionId: `bulk-${i}`,
        userId: `u${i}`,
        // Stagger validUntilSec so FIFO ordering (oldest-expiry-first)
        // is deterministic.
        validUntilSec: EXPIRED_VALID_UNTIL - (5 - i) * 100,
      });
    }
    const limited = new ValidatorEnableWatchdog(repo, alert, appendAudit, {
      staleThresholdSec: GRACE_SEC,
      batchLimit: 2,
    });
    const result = await limited.tickOnce(NOW);
    expect(result.flipped).toBe(2);
    // Oldest valid_until_sec flipped first (FIFO). bulk-0 has the
    // earliest expiry (EXPIRED_VALID_UNTIL - 500), bulk-1 next.
    const r0 = await repo.findById('bulk-0');
    const r1 = await repo.findById('bulk-1');
    const r4 = await repo.findById('bulk-4');
    expect(r0?.enableStatus).toBe('failed');
    expect(r1?.enableStatus).toBe('failed');
    expect(r4?.enableStatus).toBe('pending');
  });

  it('re-entrant guard prevents overlapping ticks', async () => {
    seed(repo, { validUntilSec: EXPIRED_VALID_UNTIL });
    const t1 = watchdog.tickOnce(NOW);
    const t2 = watchdog.tickOnce(NOW);
    const [r1, r2] = await Promise.all([t1, t2]);
    // First wins with the flip, second sees `running=true` and returns
    // immediately. The actual flip count is 1.
    const totalFlipped = r1.flipped + r2.flipped;
    expect(totalFlipped).toBe(1);
  });
});
