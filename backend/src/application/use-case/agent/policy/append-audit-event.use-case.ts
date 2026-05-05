import { randomUUID } from 'crypto';
import type { IAgentAuditRepository } from '../../../../domain/agent/repository/agent-audit.repository.js';
import { AgentAuditEvent } from '../../../../domain/agent/model/agent-audit-event.js';
import type { ActionId } from '../../../../domain/agent/model/action-id.enum.js';
import type { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import type { Surface } from '../../../../domain/agent/model/surface.enum.js';
import type { Tier } from '../../../../domain/agent/model/tier.enum.js';
import type { Trigger } from '../../../../domain/agent/model/trigger.enum.js';

export interface AppendAuditEventInput {
  userId: string;
  surface: Surface;
  eventType: AuditEventType;
  tierBefore?: Tier | null;
  tierAfter?: Tier | null;
  trigger?: Trigger | null;
  actionId?: ActionId | null;
  metadata?: Record<string, unknown> | null;
  /** Optional override — defaults to `new Date()`. Tests pin a fixed instant. */
  now?: Date;
}

/**
 * Single entry point for writing audit events. Centralized so handle-hash
 * stripping (privacy-boundary checklist from `THREAT_MODEL_P0.md`) can be
 * enforced in one place: this use case will reject any metadata key whose
 * shape matches a decrypted-FHE primitive (added in P8 hardening).
 */
export class AppendAuditEventUseCase {
  constructor(private readonly auditRepo: IAgentAuditRepository) {}

  async execute(input: AppendAuditEventInput): Promise<AgentAuditEvent> {
    const event = new AgentAuditEvent({
      id: randomUUID(),
      userId: input.userId,
      surface: input.surface,
      eventType: input.eventType,
      tierBefore: input.tierBefore ?? null,
      tierAfter: input.tierAfter ?? null,
      trigger: input.trigger ?? null,
      actionId: input.actionId ?? null,
      metadata: input.metadata ?? null,
      createdAt: input.now ?? new Date(),
    });
    await this.auditRepo.append(event);
    return event;
  }
}
