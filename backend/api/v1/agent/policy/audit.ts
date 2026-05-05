import {
  AuditQueryDtoSchema,
  toAuditEventDto,
  type AuditQueryResponseDto,
} from '../../../../src/application/dto/agent/policy.dto.js';
import { QueryAuditEventsUseCase } from '../../../../src/application/use-case/agent/policy/query-audit-events.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import {
  createGetHandler,
  sendResponse,
} from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../../src/interface/response.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const queryUseCase = new QueryAuditEventsUseCase(container.agentAuditRepo);

/**
 * GET /api/v1/agent/policy/audit?surface=&eventTypes=&since=&until=&cursor=&limit=
 *
 * Returns the authenticated user's own audit log. Pagination is opaque
 * cursor-based — the cursor encodes `(createdAt, id)` for stable
 * ordering across pages even when timestamps tie.
 *
 * P7 will introduce an admin variant for compliance officers backed by
 * permit-gated read access; this endpoint is the user-self-read only.
 */
const getHandler = createGetHandler({
  operationName: 'QueryAgentAuditEvents',
  execute: async (req, authPayload) => {
    const userId = authPayload!.userId;
    const query = req.query as Record<string, string | string[] | undefined>;

    // `eventTypes` may arrive as repeated query params (?eventTypes=a&eventTypes=b)
    // or comma-separated. Normalize to an array of strings before zod validates.
    const rawEventTypes = query.eventTypes;
    const eventTypes = Array.isArray(rawEventTypes)
      ? rawEventTypes
      : typeof rawEventTypes === 'string'
        ? rawEventTypes.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;

    const dto = AuditQueryDtoSchema.parse({
      surface: query.surface,
      eventTypes,
      since: query.since,
      until: query.until,
      cursor: query.cursor,
      limit: query.limit,
    });

    const result = await queryUseCase.execute(userId, {
      surface: dto.surface,
      eventTypes: dto.eventTypes,
      since: dto.since ? new Date(dto.since) : undefined,
      until: dto.until ? new Date(dto.until) : undefined,
      cursor: dto.cursor,
      limit: dto.limit,
    });

    const response: AuditQueryResponseDto = {
      items: result.items.map(toAuditEventDto),
      cursor: result.cursor,
    };
    return Response.ok(response);
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method === 'GET') return getHandler(req, res);
  sendResponse(res, Response.badRequest('Method not allowed'));
};

export default withCors(withAuth(router));
