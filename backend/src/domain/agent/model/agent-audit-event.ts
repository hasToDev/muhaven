import type { Surface } from './surface.enum.js';
import type { Tier } from './tier.enum.js';
import type { Trigger } from './trigger.enum.js';
import type { ActionId } from './action-id.enum.js';
import type { AuditEventType } from './audit-event-type.enum.js';

/**
 * Immutable WORM-style record. Once created, fields are read-only — the
 * repository must not expose update or delete methods. New events for the
 * same user are appended; corrections are themselves new events.
 *
 * `metadata` carries event-specific JSON. Examples:
 * - For `cron_tick`: `{ userCount, breachCount, durationMs, errors? }`
 * - For `paused`: `{ surface, breachIdHandle?, thresholdSnapshot? }`
 * - For `permit_granted`: `{ permitHash, scope, expiresAt }`
 *
 * Per `THREAT_MODEL_P0.md` privacy boundary: NEVER store decrypted FHE
 * values here. Store handle hashes only.
 */
export interface AgentAuditEventProps {
  id: string;
  userId: string;
  surface: Surface;
  eventType: AuditEventType;
  tierBefore: Tier | null;
  tierAfter: Tier | null;
  trigger: Trigger | null;
  actionId: ActionId | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export class AgentAuditEvent {
  readonly id: string;
  readonly userId: string;
  readonly surface: Surface;
  readonly eventType: AuditEventType;
  readonly tierBefore: Tier | null;
  readonly tierAfter: Tier | null;
  readonly trigger: Trigger | null;
  readonly actionId: ActionId | null;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: Date;

  constructor(props: AgentAuditEventProps) {
    this.id = props.id;
    this.userId = props.userId;
    this.surface = props.surface;
    this.eventType = props.eventType;
    this.tierBefore = props.tierBefore;
    this.tierAfter = props.tierAfter;
    this.trigger = props.trigger;
    this.actionId = props.actionId;
    this.metadata = props.metadata;
    this.createdAt = props.createdAt;
  }
}
