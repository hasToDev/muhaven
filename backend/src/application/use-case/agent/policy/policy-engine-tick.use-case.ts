import type { IAgentStateRepository } from '../../../../domain/agent/repository/agent-state.repository.js';
import type { IAgentCronStateRepository } from '../../../../domain/agent/repository/agent-cron-state.repository.js';
import { Tier } from '../../../../domain/agent/model/tier.enum.js';
import { Trigger } from '../../../../domain/agent/model/trigger.enum.js';
import { ActionId } from '../../../../domain/agent/model/action-id.enum.js';
import type { Surface } from '../../../../domain/agent/model/surface.enum.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import {
  AgentCronState,
  POLICY_ENGINE_CRON_ID,
} from '../../../../domain/agent/model/agent-cron-state.js';
import {
  BreachCode,
  type IRiskParamsAdapter,
} from '../../../../infrastructure/agent/risk-params.adapter.js';
import { PauseAgentUseCase } from './pause-agent.use-case.js';
import { AppendAuditEventUseCase } from './append-audit-event.use-case.js';

/**
 * Retry budget for transient TN errors per the 2026-04-30 P0 bench
 * findings (`development/DEV_WAVE_4/DEV_LOG.md`). One initial attempt
 * plus three retries at 200ms / 800ms / 2000ms backoff. Beyond that
 * the engine soft-fails to the audit log and does NOT auto-pause — a
 * transient ACL blip should not cascade users into Paused.
 *
 * Worst-case wall time per evaluateUser call: ~3 seconds of waits +
 * 4× decryptForTx latency (P0 measured p99 = 1.44s) ≈ 8.8s. Cron tick
 * interval is 60s so this comfortably fits under one tick.
 */
const RETRY_DELAYS_MS = [200, 800, 2000] as const;

const TRANSIENT_ERROR_PATTERNS = [/forbidden/i, /decrypt request failed/i, /timeout/i, /unavailable/i];

interface TickRunResult {
  attempted: number;
  breachesAutoPaused: number;
  softFails: number;
  errors: number;
}

export interface PolicyEngineTickInput {
  now?: Date;
}

/**
 * One iteration of the cron policy engine.
 *
 * 1. Read every user in `Policy-bound` tier across all surfaces.
 * 2. For each, call `RiskParams.checkAndExecute` (cleartext gate
 *    surfaces in `breachCode`; encrypted gate returns an `ebool` handle).
 * 3. On cleartext breach: pause immediately on the affected surface.
 * 4. On encrypted-handle path: invoke `decryptForTx` with retry budget;
 *    if the decrypt resolves to `1` (breached), pause; if it soft-fails,
 *    write an audit event and continue (no auto-pause).
 *
 * Errors at any step are caught per-user — one user's failure must not
 * stop the engine from processing the rest of the tier.
 */
export class PolicyEngineTickUseCase {
  constructor(
    private readonly stateRepo: IAgentStateRepository,
    private readonly cronStateRepo: IAgentCronStateRepository,
    private readonly riskParams: IRiskParamsAdapter,
    private readonly pauseAgent: PauseAgentUseCase,
    private readonly appendAudit: AppendAuditEventUseCase,
    private readonly sleepFn: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  async execute(input: PolicyEngineTickInput = {}): Promise<TickRunResult> {
    const now = input.now ?? new Date();
    const result: TickRunResult = { attempted: 0, breachesAutoPaused: 0, softFails: 0, errors: 0 };
    let lastError: string | null = null;

    try {
      // Wave 5 Path D — sweep both silent-spend tiers. PolicyBound enforces
      // the call-allowlist; Scoped adds the broker-side maxAmount snapshot
      // (Slice 2). The safety-gradient must NOT invert: more-autonomous
      // tiers MUST get at least as defensive a cron sweep as less-autonomous
      // ones. Single query, in() filter — same evaluation per row.
      const silentSpendTiers = await this.stateRepo.findByTiers([
        Tier.PolicyBound,
        Tier.Scoped,
      ]);
      result.attempted = silentSpendTiers.length;

      for (const state of silentSpendTiers) {
        try {
          const breached = await this.evaluateUser(state.userId, state.surface, now);
          if (breached === 'paused') {
            result.breachesAutoPaused++;
          } else if (breached === 'soft-fail') {
            result.softFails++;
          }
        } catch (err) {
          result.errors++;
          lastError = errMsg(err);
          await this.appendAudit.execute({
            userId: state.userId,
            surface: state.surface,
            eventType: AuditEventType.CronTick,
            now,
            metadata: { result: 'error', error: lastError },
          });
        }
      }
    } catch (err) {
      // Top-level "couldn't read the tier list" — bubble up via cron
      // state but do NOT throw, so the cron interval keeps running.
      lastError = errMsg(err);
      result.errors++;
    }

    await this.cronStateRepo.upsert(
      new AgentCronState({
        id: POLICY_ENGINE_CRON_ID,
        lastTickAt: now,
        lastTickUserCount: result.attempted,
        lastTickBreachCount: result.breachesAutoPaused,
        lastTickError: lastError,
        updatedAt: now,
      }),
    );

    return result;
  }

  /**
   * Per-user evaluation for one (userId, surface) row. Returns:
   * - `'ok'` on clean check
   * - `'paused'` on confirmed breach + pause
   * - `'soft-fail'` on transient errors that exhaust the retry budget
   *
   * The `surface` argument is the one that owns this Policy-bound state
   * — pause MUST flow back to that surface, not a hardcoded one. Cascading
   * triggers (e.g., KYC revocation) still apply across all surfaces because
   * `pauseAgent.execute` consults `isCascading(trigger)`.
   */
  private async evaluateUser(
    userId: string,
    surface: Surface,
    now: Date,
  ): Promise<'ok' | 'paused' | 'soft-fail'> {
    // P6 will pass a real eAmount derived from the user's recent action
    // pattern. P1 stub: pass a placeholder; the StubRiskParamsAdapter
    // ignores the value.
    const eAmountPlaceholder = { __stub: true };

    let check;
    try {
      check = await this.riskParams.checkAndExecute(userId, eAmountPlaceholder, ActionId.Buy);
    } catch (err) {
      if (isTransient(err)) {
        // Symmetric with the encrypted-handle soft-fail path below — both
        // emit a per-user audit entry so a TN-side `checkAndExecute` failure
        // leaves a forensic trail, not just an aggregate `lastTickError` on
        // the cron-state row.
        await this.appendAudit.execute({
          userId,
          surface,
          eventType: AuditEventType.CronTick,
          now,
          metadata: { result: 'soft-fail-check' },
        });
        return 'soft-fail';
      }
      throw err;
    }

    if (check.breachCode !== BreachCode.None) {
      await this.pauseAgent.execute({
        userId,
        surface,
        trigger: cleartextBreachToTrigger(check.breachCode),
        metadata: { breachCode: check.breachCode, source: 'cron-tick' },
        now,
      });
      return 'paused';
    }

    if (check.ePassedHandle === null) {
      return 'ok';
    }

    // Encrypted-handle path — invoke decryptForTx with retry budget.
    const decrypted = await this.decryptWithRetry(check.ePassedHandle);
    if (decrypted === null) {
      // Soft-fail: log & continue, do NOT auto-pause.
      await this.appendAudit.execute({
        userId,
        surface,
        eventType: AuditEventType.CronTick,
        now,
        metadata: { result: 'soft-fail-decrypt' },
      });
      return 'soft-fail';
    }

    if (decrypted === 0) {
      // ebool=0 means `ePassed=false` → breach — pause.
      await this.pauseAgent.execute({
        userId,
        surface,
        trigger: Trigger.DrawdownBreach,
        metadata: { source: 'cron-tick-encrypted-breach' },
        now,
      });
      return 'paused';
    }

    return 'ok';
  }

  private async decryptWithRetry(handle: string): Promise<0 | 1 | null> {
    // Total attempts = 1 initial + RETRY_DELAYS_MS.length retries.
    const totalAttempts = RETRY_DELAYS_MS.length + 1;
    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      if (attempt > 0) {
        await this.sleepFn(RETRY_DELAYS_MS[attempt - 1]);
      }
      try {
        const out = await this.riskParams.decryptBreachFlag(handle);
        return out.cleartext;
      } catch (err) {
        if (!isTransient(err)) throw err;
        // last error is intentionally swallowed — soft-fail is the contract.
      }
    }
    return null;
  }
}

function isTransient(err: unknown): boolean {
  const msg = errMsg(err);
  return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(msg));
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err);
}

function cleartextBreachToTrigger(code: BreachCode): Trigger {
  switch (code) {
    case BreachCode.OracleStale:
      return Trigger.OracleDeviation;
    case BreachCode.KycRevoked:
      return Trigger.KycRevoked;
    case BreachCode.UserPaused:
    case BreachCode.None:
    default:
      return Trigger.DrawdownBreach;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
