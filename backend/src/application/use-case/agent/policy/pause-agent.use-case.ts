import type { IAgentStateRepository } from '../../../../domain/agent/repository/agent-state.repository.js';
import { triggerPause, resumeAfterPause } from '../../../../domain/agent/model/state-machine.js';
import { Tier } from '../../../../domain/agent/model/tier.enum.js';
import {
  Surface,
  SURFACE_VALUES,
} from '../../../../domain/agent/model/surface.enum.js';
import { Trigger, isCascading } from '../../../../domain/agent/model/trigger.enum.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import { GetPolicyStateUseCase } from './get-policy-state.use-case.js';
import { AppendAuditEventUseCase } from './append-audit-event.use-case.js';

export interface PauseAgentInput {
  userId: string;
  /**
   * Target surface for non-cascading triggers. For cascading triggers
   * (T-5 KYC revocation, T-6 account recovery) every surface is paused
   * regardless of this argument — the field is logged for audit context.
   */
  surface: Surface;
  trigger: Trigger;
  metadata?: Record<string, unknown> | null;
  now?: Date;
}

export interface PauseAgentResult {
  pausedSurfaces: Surface[];
  cascade: boolean;
}

/**
 * Pause kill-switch (T-1..T-7). Cascading triggers freeze every surface;
 * surface-scoped triggers freeze only the targeted surface.
 *
 * Idempotent: re-pausing a paused user updates `pausedAt` / `trigger` to
 * the latest source and writes a fresh audit event. Concurrent callers
 * get last-write-wins on the upsert; the audit log preserves order.
 */
export class PauseAgentUseCase {
  constructor(
    private readonly stateRepo: IAgentStateRepository,
    private readonly getPolicyState: GetPolicyStateUseCase,
    private readonly appendAudit: AppendAuditEventUseCase,
  ) {}

  async execute(input: PauseAgentInput): Promise<PauseAgentResult> {
    const now = input.now ?? new Date();
    const cascade = isCascading(input.trigger);
    const surfaces: Surface[] = cascade ? [...SURFACE_VALUES] : [input.surface];

    for (const surface of surfaces) {
      const current = await this.getPolicyState.forSurface(input.userId, surface, now);

      const result = triggerPause(current, input.trigger, input.metadata ?? null, { now });
      await this.stateRepo.upsert(result.state);
      await this.appendAudit.execute({
        userId: input.userId,
        surface,
        eventType: AuditEventType.Paused,
        tierBefore: current.tier,
        tierAfter: Tier.Paused,
        trigger: input.trigger,
        now,
        metadata: input.metadata ?? null,
      });
    }

    if (input.trigger === Trigger.KycRevoked) {
      await this.appendAudit.execute({
        userId: input.userId,
        surface: input.surface,
        eventType: AuditEventType.KycRevocationReceived,
        now,
        metadata: input.metadata ?? null,
      });
    }

    return { pausedSurfaces: surfaces, cascade };
  }
}

export interface ResumeAgentInput {
  userId: string;
  surface: Surface;
  now?: Date;
}

/**
 * Resume from `paused` → `advisory`. Always lands in Advisory per
 * ADR-0 — the user re-traverses Confirm → PolicyBound to regain
 * autonomy. Returns `409 Conflict` if the surface is not actually paused.
 */
export class ResumeAgentUseCase {
  constructor(
    private readonly stateRepo: IAgentStateRepository,
    private readonly getPolicyState: GetPolicyStateUseCase,
    private readonly appendAudit: AppendAuditEventUseCase,
  ) {}

  async execute(input: ResumeAgentInput): Promise<void> {
    const now = input.now ?? new Date();
    const current = await this.getPolicyState.forSurface(input.userId, input.surface, now);

    const result = resumeAfterPause(current, { now });
    if (!result.ok) {
      throw ApplicationHttpError.conflict(result.message);
    }

    await this.stateRepo.upsert(result.state);
    await this.appendAudit.execute({
      userId: input.userId,
      surface: input.surface,
      eventType: AuditEventType.Resumed,
      tierBefore: Tier.Paused,
      tierAfter: Tier.Advisory,
      now,
    });
  }
}
