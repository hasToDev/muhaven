import type { IAgentAuditRepository } from '../../../../domain/agent/repository/agent-audit.repository.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import type {
  AuditQueryToolDto,
  AuditQueryToolResponseDto,
} from '../../../dto/agent/issuer-tool.dto.js';

/** Hard cap on the (until - since) range — defends against an LLM that
 *  emits a wide window plus a paginated drain. 90 days mirrors the
 *  retention horizon discussed in `THREAT_MODEL_P0.md` §"Audit log
 *  retention". Wave 5 may extend per a permit-gated compliance-officer
 *  variant, but the LLM-callable surface stays bounded. */
const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface AuditQueryToolContext {
  userId: string;
}

/**
 * Wave 4 P7 — `muhaven_audit_query`.
 *
 * Read-only LLM-callable wrapper over the existing
 * `QueryAuditEventsUseCase` shape. Wave 4 scope is **issuer-self only** —
 * the audit log returned is always the calling user's own. The
 * cross-user permit-gated path (the "compliance officer" surface) defers
 * to Wave 5; ADR-8 §"Wave 5 follow-ups" pins the upgrade-path so it
 * lands additively (new `permit` field, server-side EIP-712 verifier,
 * existing scopedTo response field flips from `'self'` to a user-id).
 *
 * Why a separate tool from `GET /api/v1/agent/policy/audit`: HavenBot
 * needs an LLM-tool entry-point with a structured-output contract +
 * tool-name pin (R-1 / R-2 mitigations). Routing everything through the
 * existing REST route would force the planner to hallucinate query
 * params; this gives it a sanitised + validated DTO surface.
 *
 * Privacy note: the audit-event metadata is already cleartext-by-design
 * (every Wave 4 propose tool writes only cleartext fields per the
 * THREAT_MODEL_P0 boundary). The P8 sanitiseToolResult pass strips
 * ANSI / Tag-block / bidi from every string field on the way out, so
 * smuggled bytes can't rewrite the chat history visually.
 */
export class AuditQueryToolUseCase {
  constructor(private readonly auditRepo: IAgentAuditRepository) {}

  async execute(
    ctx: AuditQueryToolContext,
    input: AuditQueryToolDto,
  ): Promise<AuditQueryToolResponseDto> {
    const since = input.since ? new Date(input.since) : undefined;
    const until = input.until ? new Date(input.until) : undefined;

    // M1 mitigation: clamp the (until - since) range so a malicious
    // planner that emits a 30-year window + paginated drain can't burn
    // the audit-log query budget. 90-day cap matches the retention
    // horizon. Defaults: when only one bound is provided, the other
    // is inferred to keep the window ≤ MAX_RANGE_MS.
    if (since && until) {
      if (until.getTime() < since.getTime()) {
        throw ApplicationHttpError.badRequest('`until` must be after `since`.');
      }
      if (until.getTime() - since.getTime() > MAX_RANGE_MS) {
        throw ApplicationHttpError.badRequest(
          'Audit query window may not exceed 90 days.',
        );
      }
    }

    const result = await this.auditRepo.findByUserId(ctx.userId, {
      surface: input.surface,
      eventTypes: input.eventTypes,
      since,
      until,
      cursor: input.cursor,
      limit: input.limit ?? 50,
    });

    return {
      tool: 'muhaven_audit_query',
      scopedTo: 'self',
      items: result.items.map((event) => ({
        id: event.id,
        surface: event.surface,
        eventType: event.eventType,
        actionId: event.actionId,
        metadata: event.metadata,
        createdAt: event.createdAt.toISOString(),
      })),
      cursor: result.cursor,
    };
  }
}
