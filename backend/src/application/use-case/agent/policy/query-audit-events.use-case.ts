import type {
  AuditEventQueryOptions,
  IAgentAuditRepository,
  PaginatedAuditEvents,
} from '../../../../domain/agent/repository/agent-audit.repository.js';

/**
 * Read-only access to a user's own audit log. The repository enforces
 * pagination + size cap. P7 will introduce a permit-gated `audit-mode`
 * variant for compliance officers reading another user's log; this
 * single-user variant is the only one exposed in P1.
 */
export class QueryAuditEventsUseCase {
  constructor(private readonly auditRepo: IAgentAuditRepository) {}

  async execute(userId: string, options?: AuditEventQueryOptions): Promise<PaginatedAuditEvents> {
    return this.auditRepo.findByUserId(userId, options);
  }
}
