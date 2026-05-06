import { Surface } from '../../../../src/domain/agent/model/surface.enum.js';
import { AuditQueryToolDtoSchema } from '../../../../src/application/dto/agent/issuer-tool.dto.js';
import { container } from '../../../../src/infrastructure/container.js';
import {
  createGetHandler,
  sendResponse,
} from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../src/interface/response.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Wave 4 P7 — `muhaven_audit_query` tool route.
 *
 * GET-shaped because the audit log is a read; LLM tool dispatch goes
 * through the same backend `ToolDispatcher` so the planner is offered a
 * uniform proposal surface. Issuer-self only in Wave 4 — the
 * cross-user permit-gated variant defers to Wave 5 per ADR-8.
 */
const getHandler = createGetHandler({
  operationName: 'AgentToolAuditQuery',
  execute: async (req, authPayload) => {
    const query = req.query as Record<string, string | string[] | undefined>;

    // `eventTypes` may arrive as repeated query params or comma-separated.
    // Mirror the existing `/agent/policy/audit` route's normalisation so
    // tools and direct REST consumers behave identically.
    const rawEventTypes = query.eventTypes;
    const eventTypes = Array.isArray(rawEventTypes)
      ? rawEventTypes
      : typeof rawEventTypes === 'string'
        ? rawEventTypes.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;

    const dto = AuditQueryToolDtoSchema.parse({
      surface: query.surface,
      eventTypes,
      since: query.since,
      until: query.until,
      cursor: query.cursor,
      limit: query.limit,
    });

    const result = await container.toolDispatcher.dispatch(
      {
        userId: authPayload!.userId,
        walletAddress: authPayload!.walletAddress,
        surface: Surface.HavenBot,
      },
      'muhaven_audit_query',
      dto,
    );
    return Response.ok(result);
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method === 'GET') return getHandler(req, res);
  sendResponse(res, Response.badRequest('Method not allowed'));
};

// Read-side scope per ADR-3 D2.
export default withCors(withAuth(withScope(['mcp.read.*'])(router)));
