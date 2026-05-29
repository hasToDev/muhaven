import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

beforeAll(() => {
  process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-chars-long';
});

import type { IScopedSessionRepository } from '../../../../../domain/agent/repository/scoped-session.repository.js';
import type { ScopedSession } from '../../../../../domain/agent/model/scoped-session.js';
import type {
  IAgentAuditRepository,
  PaginatedAuditEvents,
} from '../../../../../domain/agent/repository/agent-audit.repository.js';
import { AgentAuditEvent } from '../../../../../domain/agent/model/agent-audit-event.js';
import { AppendAuditEventUseCase } from '../../policy/append-audit-event.use-case.js';
import { RecordReinvestCycleUseCase } from '../record-reinvest-cycle.use-case.js';
import type { RecordReinvestCycleInput } from '../record-reinvest-cycle.use-case.js';

const USER_ID = 'user-uuid-0001';
const TOKEN = '0x1d6C140204F21835F1AF2A0615826A333827d946';
const SNAPSHOT = '0x797b9a2ec6F752B791DcE2f721Ad51Da68074Ed3';
const USEROP = '0x' + 'ab'.repeat(32);
const TXHASH = '0x' + 'cd'.repeat(32);
const CYCLE_ID = '11111111-2222-4333-8444-555555555555';

function baseInput(over: Partial<RecordReinvestCycleInput> = {}): RecordReinvestCycleInput {
  return {
    userId: USER_ID,
    reinvestCycleId: CYCLE_ID,
    epochId: '6',
    tokenAddress: TOKEN,
    snapshotAddress: SNAPSHOT,
    userOpHash: USEROP,
    txHash: TXHASH,
    buyShares: '1',
    budgetUsd6: '1000000',
    ...over,
  };
}

function makeScopedRepo(hasActive: boolean): IScopedSessionRepository {
  return {
    findLatestActive: vi.fn(async () =>
      hasActive ? ({ sessionId: 'sess_active' } as unknown as ScopedSession) : null,
    ),
  } as unknown as IScopedSessionRepository;
}

function makeAuditRepo(prior: AgentAuditEvent[] = []): {
  repo: IAgentAuditRepository;
  append: ReturnType<typeof vi.fn>;
  findByUserId: ReturnType<typeof vi.fn>;
} {
  const append = vi.fn(async () => {});
  const findByUserId = vi.fn(
    async (): Promise<PaginatedAuditEvents> => ({ items: prior }),
  );
  return {
    repo: { append, findByUserId } as unknown as IAgentAuditRepository,
    append,
    findByUserId,
  };
}

function priorReinvestEvent(meta: Record<string, unknown>): AgentAuditEvent {
  return new AgentAuditEvent({
    id: 'evt-1',
    userId: USER_ID,
    surface: 'mcp' as never,
    eventType: 'reinvest_cycle_executed' as never,
    tierBefore: null,
    tierAfter: null,
    trigger: null,
    actionId: null,
    metadata: meta,
    createdAt: new Date(),
  });
}

describe('RecordReinvestCycleUseCase', () => {
  let scoped: IScopedSessionRepository;

  beforeEach(() => {
    scoped = makeScopedRepo(true);
  });

  it('appends a reinvest_cycle_executed audit row on the happy path', async () => {
    const { repo, append } = makeAuditRepo();
    const uc = new RecordReinvestCycleUseCase(scoped, repo, new AppendAuditEventUseCase(repo));
    const res = await uc.execute(baseInput());
    expect(res).toEqual({ recorded: true, reinvestCycleId: CYCLE_ID });
    expect(append).toHaveBeenCalledTimes(1);
    const appended = append.mock.calls[0][0] as AgentAuditEvent;
    expect(appended.eventType).toBe('reinvest_cycle_executed');
    expect(appended.metadata).toMatchObject({
      reinvestCycleId: CYCLE_ID,
      epochId: '6',
      token: TOKEN.toLowerCase(),
      snapshot: SNAPSHOT.toLowerCase(),
      userOpHash: USEROP,
      txHash: TXHASH,
      buyShares: '1',
      budgetUsd6: '1000000',
    });
  });

  it('omits txHash from metadata when not provided (submit-but-timeout)', async () => {
    const { repo, append } = makeAuditRepo();
    const uc = new RecordReinvestCycleUseCase(scoped, repo, new AppendAuditEventUseCase(repo));
    await uc.execute(baseInput({ txHash: undefined }));
    const appended = append.mock.calls[0][0] as AgentAuditEvent;
    expect(appended.metadata).not.toHaveProperty('txHash');
  });

  it('is idempotent per (user, epoch) — a duplicate cycle is NOT re-appended', async () => {
    const { repo, append } = makeAuditRepo([
      priorReinvestEvent({ epochId: '6', token: TOKEN.toLowerCase(), snapshot: SNAPSHOT.toLowerCase() }),
    ]);
    const uc = new RecordReinvestCycleUseCase(scoped, repo, new AppendAuditEventUseCase(repo));
    const res = await uc.execute(baseInput());
    expect(res.recorded).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });

  it('does NOT dedup against a different epoch of the same token', async () => {
    const { repo, append } = makeAuditRepo([
      priorReinvestEvent({ epochId: '5', token: TOKEN.toLowerCase(), snapshot: SNAPSHOT.toLowerCase() }),
    ]);
    const uc = new RecordReinvestCycleUseCase(scoped, repo, new AppendAuditEventUseCase(repo));
    const res = await uc.execute(baseInput({ epochId: '6' }));
    expect(res.recorded).toBe(true);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('rejects with 403 when there is no active scoped session (revoke kill-switch)', async () => {
    const { repo, append, findByUserId } = makeAuditRepo();
    const uc = new RecordReinvestCycleUseCase(
      makeScopedRepo(false),
      repo,
      new AppendAuditEventUseCase(repo),
    );
    await expect(uc.execute(baseInput())).rejects.toMatchObject({ statusCode: 403 });
    expect(findByUserId).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('rejects a malformed tokenAddress with 400', async () => {
    const { repo } = makeAuditRepo();
    const uc = new RecordReinvestCycleUseCase(scoped, repo, new AppendAuditEventUseCase(repo));
    await expect(
      uc.execute(baseInput({ tokenAddress: 'nope' })),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
