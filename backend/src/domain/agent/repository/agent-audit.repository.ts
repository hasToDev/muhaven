import type { AgentAuditEvent } from '../model/agent-audit-event.js';
import type { AuditEventType } from '../model/audit-event-type.enum.js';
import type { Surface } from '../model/surface.enum.js';

export interface AuditEventQueryOptions {
  /** Inclusive lower bound on `createdAt`. */
  since?: Date;
  /** Inclusive upper bound on `createdAt`. */
  until?: Date;
  /** Filter to a single surface. */
  surface?: Surface;
  /** Restrict to one or more event types. */
  eventTypes?: AuditEventType[];
  /** Pagination — opaque cursor returned from the previous page. */
  cursor?: string;
  /** Page size (server may cap). */
  limit?: number;
}

export interface PaginatedAuditEvents {
  items: AgentAuditEvent[];
  /** Opaque cursor for the next page; undefined when exhausted. */
  cursor?: string;
}

/**
 * The audit-event repository is **append-only** by contract. Implementations
 * MUST NOT expose `update` or `delete` methods on this interface — the WORM
 * property is part of the threat model (R-3 audit-log tampering, AGT09 from
 * `THREAT_MODEL_P0.md`). Production deployments should enforce this at the
 * Postgres role level too (revoke UPDATE/DELETE on the table).
 */
export interface IAgentAuditRepository {
  append(event: AgentAuditEvent): Promise<void>;
  findByUserId(userId: string, options?: AuditEventQueryOptions): Promise<PaginatedAuditEvents>;
}
