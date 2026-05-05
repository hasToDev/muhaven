import { z } from 'zod';
import { TIER_VALUES, type Tier } from '../../../domain/agent/model/tier.enum.js';
import { SURFACE_VALUES, type Surface } from '../../../domain/agent/model/surface.enum.js';
import type { Trigger } from '../../../domain/agent/model/trigger.enum.js';
import type { ActionId } from '../../../domain/agent/model/action-id.enum.js';
import { AUDIT_EVENT_TYPE_VALUES, type AuditEventType } from '../../../domain/agent/model/audit-event-type.enum.js';
import type { AgentUserState } from '../../../domain/agent/model/agent-user-state.js';
import type { AgentAuditEvent } from '../../../domain/agent/model/agent-audit-event.js';

const tierSchema = z.enum(TIER_VALUES as readonly [Tier, ...Tier[]]);
const surfaceSchema = z.enum(SURFACE_VALUES as readonly [Surface, ...Surface[]]);
const actionIdSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
const auditEventTypeSchema = z.enum(
  AUDIT_EVENT_TYPE_VALUES as readonly [AuditEventType, ...AuditEventType[]],
);

export const RequestTierTransitionDtoSchema = z
  .object({
    surface: surfaceSchema,
    targetTier: tierSchema,
  })
  .strict();

export type RequestTierTransitionDto = z.infer<typeof RequestTierTransitionDtoSchema>;

export const CommitTierTransitionDtoSchema = z
  .object({
    surface: surfaceSchema,
    targetTier: tierSchema,
    confirmationToken: z.string().min(8).max(128),
  })
  .strict();

export type CommitTierTransitionDto = z.infer<typeof CommitTierTransitionDtoSchema>;

export const PauseDtoSchema = z
  .object({
    surface: surfaceSchema.optional(),
  })
  .strict();

export type PauseDto = z.infer<typeof PauseDtoSchema>;

export const ResumeDtoSchema = z
  .object({
    surface: surfaceSchema,
  })
  .strict();

export type ResumeDto = z.infer<typeof ResumeDtoSchema>;

export const BuildPermissionTemplateDtoSchema = z
  .object({
    tier: tierSchema,
    actions: z.array(actionIdSchema).min(0),
    ttlSec: z.number().int().min(60).max(86_400).optional(),
  })
  .strict();

export type BuildPermissionTemplateDto = z.infer<typeof BuildPermissionTemplateDtoSchema>;

export const AuditQueryDtoSchema = z
  .object({
    surface: surfaceSchema.optional(),
    eventTypes: z.array(auditEventTypeSchema).max(20).optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type AuditQueryDto = z.infer<typeof AuditQueryDtoSchema>;

export interface AgentUserStateDto {
  userId: string;
  surface: Surface;
  tier: Tier;
  pausedAt: string | null;
  pauseTrigger: Trigger | null;
  pauseMetadata: Record<string, unknown> | null;
  enteredAt: string;
  validatorAddress: string | null;
  confirmedActionCount: number;
  riskQuestionnaireComplete: boolean;
  updatedAt: string;
}

export function toUserStateDto(state: AgentUserState): AgentUserStateDto {
  return {
    userId: state.userId,
    surface: state.surface,
    tier: state.tier,
    pausedAt: state.pausedAt?.toISOString() ?? null,
    pauseTrigger: state.pauseTrigger,
    pauseMetadata: state.pauseMetadata,
    enteredAt: state.enteredAt.toISOString(),
    validatorAddress: state.validatorAddress,
    confirmedActionCount: state.confirmedActionCount,
    riskQuestionnaireComplete: state.riskQuestionnaireComplete,
    updatedAt: state.updatedAt.toISOString(),
  };
}

export interface AgentAuditEventDto {
  id: string;
  userId: string;
  surface: Surface;
  eventType: AuditEventType;
  tierBefore: Tier | null;
  tierAfter: Tier | null;
  trigger: Trigger | null;
  actionId: ActionId | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export function toAuditEventDto(event: AgentAuditEvent): AgentAuditEventDto {
  return {
    id: event.id,
    userId: event.userId,
    surface: event.surface,
    eventType: event.eventType,
    tierBefore: event.tierBefore,
    tierAfter: event.tierAfter,
    trigger: event.trigger,
    actionId: event.actionId,
    metadata: event.metadata,
    createdAt: event.createdAt.toISOString(),
  };
}

export interface PolicyStateResponseDto {
  surfaces: AgentUserStateDto[];
}

export interface PauseResponseDto {
  pausedSurfaces: Surface[];
  cascade: boolean;
}

export interface AuditQueryResponseDto {
  items: AgentAuditEventDto[];
  cursor?: string;
}
