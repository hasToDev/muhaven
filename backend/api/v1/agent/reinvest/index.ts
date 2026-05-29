import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { container } from '../../../../src/infrastructure/container.js';
import {
  createHandler,
  sendResponse,
} from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../src/interface/response.js';
import { toScopedSessionDto } from '../../../../src/application/dto/agent/policy.dto.js';

/**
 * POST /api/v1/agent/reinvest
 *
 * Wave 5 Slice 2 — toggle the `reinvest_enabled` opt-in on the caller's
 * active MCP Scoped session (the Autonomy-page toggle). Body:
 * `{ enabled: boolean }`. 404 when there is no active session to toggle.
 * Scope `mcp.propose.*` (a state change); SIWE tokens fall through as
 * full-access so the dashboard toggle works.
 */
const ReinvestToggleDtoSchema = z.object({ enabled: z.boolean() }).strict();

const handler = createHandler({
  operationName: 'SetReinvestEnabled',
  schema: ReinvestToggleDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const session = await container.setReinvestEnabled.execute({
      userId: authPayload!.userId,
      enabled: dto.enabled,
    });
    return Response.ok({ session: toScopedSessionDto(session) });
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'POST') {
    sendResponse(res, Response.badRequest('Method not allowed'));
    return;
  }
  return handler(req, res);
};

export default withCors(withAuth(withScope(['mcp.propose.*'])(router)));
