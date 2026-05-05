import { describe, it, expect, beforeEach } from 'vitest';
import {
  MemoryAgentStateRepository,
  MemoryAgentAuditRepository,
  MemoryAgentCronStateRepository,
} from '../../../../../infrastructure/repository/memory/index.js';
import { AgentUserState } from '../../../../../domain/agent/model/agent-user-state.js';
import { Tier } from '../../../../../domain/agent/model/tier.enum.js';
import { Surface } from '../../../../../domain/agent/model/surface.enum.js';
import { Trigger } from '../../../../../domain/agent/model/trigger.enum.js';
import { ActionId } from '../../../../../domain/agent/model/action-id.enum.js';
import { AuditEventType } from '../../../../../domain/agent/model/audit-event-type.enum.js';
import {
  BreachCode,
  type IRiskParamsAdapter,
  type CheckAndExecuteResult,
} from '../../../../../infrastructure/agent/risk-params.adapter.js';
import { PauseAgentUseCase } from '../pause-agent.use-case.js';
import { GetPolicyStateUseCase } from '../get-policy-state.use-case.js';
import { AppendAuditEventUseCase } from '../append-audit-event.use-case.js';
import { PolicyEngineTickUseCase } from '../policy-engine-tick.use-case.js';

class FakeRiskParamsAdapter implements IRiskParamsAdapter {
  checkResult: CheckAndExecuteResult = { ePassedHandle: null, breachCode: BreachCode.None };
  decryptResult: 0 | 1 = 0;
  decryptThrowsTransientCount = 0;
  decryptThrowsHardOnFirstCall = false;
  checkThrowsTransientCount = 0;

  async checkAndExecute(_investor: string, _eAmount: unknown, _actionId: ActionId) {
    if (this.checkThrowsTransientCount > 0) {
      this.checkThrowsTransientCount--;
      throw new Error('decrypt request failed: Forbidden');
    }
    return this.checkResult;
  }

  async decryptBreachFlag(_handle: string) {
    if (this.decryptThrowsHardOnFirstCall) {
      this.decryptThrowsHardOnFirstCall = false;
      throw new Error('non-transient catastrophe');
    }
    if (this.decryptThrowsTransientCount > 0) {
      this.decryptThrowsTransientCount--;
      throw new Error('decrypt request failed: Forbidden');
    }
    return { cleartext: this.decryptResult, signature: '0x' + 'a'.repeat(130) };
  }
}

const NOW = new Date('2026-04-30T01:00:00.000Z');

function makePolicyBoundUser(overrides: Partial<AgentUserState> = {}): AgentUserState {
  return new AgentUserState({
    userId: 'u1',
    surface: Surface.HavenBot,
    tier: Tier.PolicyBound,
    pausedAt: null,
    pauseTrigger: null,
    pauseMetadata: null,
    enteredAt: NOW,
    validatorAddress: '0xvalidator',
    confirmedActionCount: 5,
    riskQuestionnaireComplete: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe('PolicyEngineTickUseCase', () => {
  let stateRepo: MemoryAgentStateRepository;
  let auditRepo: MemoryAgentAuditRepository;
  let cronStateRepo: MemoryAgentCronStateRepository;
  let adapter: FakeRiskParamsAdapter;
  let tick: PolicyEngineTickUseCase;
  // No real waiting in tests — sleep is synchronous resolve.
  const noopSleep = (_ms: number) => Promise.resolve();

  beforeEach(() => {
    stateRepo = new MemoryAgentStateRepository();
    auditRepo = new MemoryAgentAuditRepository();
    cronStateRepo = new MemoryAgentCronStateRepository();
    adapter = new FakeRiskParamsAdapter();
    const getPolicyState = new GetPolicyStateUseCase(stateRepo);
    const appendAudit = new AppendAuditEventUseCase(auditRepo);
    const pauseAgent = new PauseAgentUseCase(stateRepo, getPolicyState, appendAudit);
    tick = new PolicyEngineTickUseCase(stateRepo, cronStateRepo, adapter, pauseAgent, appendAudit, noopSleep);
  });

  it('no policy-bound users — tick is a no-op + heartbeat', async () => {
    const result = await tick.execute({ now: NOW });
    expect(result).toEqual({ attempted: 0, breachesAutoPaused: 0, softFails: 0, errors: 0 });
    const cron = await cronStateRepo.findById('policy-engine');
    expect(cron?.lastTickAt).toEqual(NOW);
    expect(cron?.lastTickUserCount).toBe(0);
  });

  it('clean check on policy-bound user — no pause + no audit', async () => {
    await stateRepo.upsert(makePolicyBoundUser());
    const result = await tick.execute({ now: NOW });
    expect(result.attempted).toBe(1);
    expect(result.breachesAutoPaused).toBe(0);
    const post = await stateRepo.findByUserAndSurface('u1', Surface.HavenBot);
    expect(post?.tier).toBe(Tier.PolicyBound);
  });

  it('cleartext breach (oracle stale) — pauses on the user’s actual surface', async () => {
    await stateRepo.upsert(makePolicyBoundUser({ surface: Surface.MCP }));
    adapter.checkResult = { ePassedHandle: null, breachCode: BreachCode.OracleStale };
    const result = await tick.execute({ now: NOW });
    expect(result.breachesAutoPaused).toBe(1);
    const post = await stateRepo.findByUserAndSurface('u1', Surface.MCP);
    expect(post?.tier).toBe(Tier.Paused);
    expect(post?.pauseTrigger).toBe(Trigger.OracleDeviation);
  });

  it('encrypted-breach handle decrypts to 0 → pause via DrawdownBreach trigger', async () => {
    await stateRepo.upsert(makePolicyBoundUser({ surface: Surface.OpenClaw }));
    adapter.checkResult = { ePassedHandle: '0xhandle', breachCode: BreachCode.None };
    adapter.decryptResult = 0;
    const result = await tick.execute({ now: NOW });
    expect(result.breachesAutoPaused).toBe(1);
    const post = await stateRepo.findByUserAndSurface('u1', Surface.OpenClaw);
    expect(post?.tier).toBe(Tier.Paused);
    expect(post?.pauseTrigger).toBe(Trigger.DrawdownBreach);
  });

  it('encrypted-breach handle decrypts to 1 → no pause', async () => {
    await stateRepo.upsert(makePolicyBoundUser());
    adapter.checkResult = { ePassedHandle: '0xhandle', breachCode: BreachCode.None };
    adapter.decryptResult = 1;
    const result = await tick.execute({ now: NOW });
    expect(result.breachesAutoPaused).toBe(0);
    const post = await stateRepo.findByUserAndSurface('u1', Surface.HavenBot);
    expect(post?.tier).toBe(Tier.PolicyBound);
  });

  it('transient decrypt errors — retry budget recovers', async () => {
    await stateRepo.upsert(makePolicyBoundUser());
    adapter.checkResult = { ePassedHandle: '0xhandle', breachCode: BreachCode.None };
    adapter.decryptThrowsTransientCount = 2; // first 2 calls fail, 3rd succeeds
    adapter.decryptResult = 1;
    const result = await tick.execute({ now: NOW });
    expect(result.attempted).toBe(1);
    expect(result.breachesAutoPaused).toBe(0);
    expect(result.softFails).toBe(0);
  });

  it('transient decrypt errors — exhausting retry budget soft-fails (no pause)', async () => {
    await stateRepo.upsert(makePolicyBoundUser());
    adapter.checkResult = { ePassedHandle: '0xhandle', breachCode: BreachCode.None };
    adapter.decryptThrowsTransientCount = 99; // never recovers within budget
    const result = await tick.execute({ now: NOW });
    expect(result.softFails).toBe(1);
    expect(result.breachesAutoPaused).toBe(0);
    const post = await stateRepo.findByUserAndSurface('u1', Surface.HavenBot);
    expect(post?.tier).toBe(Tier.PolicyBound); // NOT paused
    const audit = await auditRepo.findByUserId('u1');
    const softFail = audit.items.find(
      (e) =>
        e.eventType === AuditEventType.CronTick &&
        (e.metadata as Record<string, unknown> | null)?.result === 'soft-fail-decrypt',
    );
    expect(softFail).toBeDefined();
  });

  it('non-transient error in checkAndExecute is per-user — does not abort the tick', async () => {
    await stateRepo.upsert(makePolicyBoundUser({ userId: 'a' }));
    await stateRepo.upsert(makePolicyBoundUser({ userId: 'b', surface: Surface.MCP }));
    let calls = 0;
    adapter.checkAndExecute = async () => {
      calls++;
      if (calls === 1) throw new Error('non-transient explosion');
      return { ePassedHandle: null, breachCode: BreachCode.None };
    };
    const result = await tick.execute({ now: NOW });
    expect(result.errors).toBe(1);
    expect(result.attempted).toBe(2);
  });

  it('cron heartbeat captures attempted + breach counts even on partial errors', async () => {
    await stateRepo.upsert(makePolicyBoundUser({ userId: 'a' }));
    adapter.checkResult = { ePassedHandle: null, breachCode: BreachCode.OracleStale };
    await tick.execute({ now: NOW });
    const cron = await cronStateRepo.findById('policy-engine');
    expect(cron?.lastTickUserCount).toBe(1);
    expect(cron?.lastTickBreachCount).toBe(1);
  });
});
