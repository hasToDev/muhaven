import {
  RevokeScopedSessionParamsSchema,
  toScopedSessionDto,
} from '../../../../../src/application/dto/agent/policy.dto.js';
import { RevokeScopedSessionUseCase } from '../../../../../src/application/use-case/agent/policy/revoke-scoped-session.use-case.js';
import { container } from '../../../../../src/infrastructure/container.js';
import {
  sendResponse,
  type AuthenticatedRequest,
} from '../../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../../src/interface/response.js';
import { ApplicationHttpError } from '../../../../../src/core/errors.js';
import { getLogger } from '../../../../../src/core/logger.js';
import { ZodError } from 'zod';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const log = getLogger('RevokeScopedSession');

/**
 * Wave 5 Path D Slice 2 Commit 2.A · DELETE /policy/scoped-session/:sessionId.
 *
 * Lives in its own dynamic-segment file (per the repo's `[param].ts`
 * convention) so the dev-server file-based router can match the path
 * tail at all — the previous design that tried to extract the tail
 * inside the `scoped-session.ts` collection handler was unreachable
 * because `scanRoutes` anchors the regex to the literal path. Vercel's
 * file-based router uses the same `[param]` convention.
 *
 * The dev-server / Vercel pass `:sessionId` via `req.query.sessionId`
 * (see `dev-server.ts::main` lines 202-208 — pathParams merge into the
 * query map). Zod re-parses through `RevokeScopedSessionParamsSchema`
 * to enforce the broker's `SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/`
 * defense-in-depth — a future route-scanner regex relaxation can't slip
 * a path-traversal value past this gate.
 *
 * Auth: passkey-JWT (SIWE legacy fallback path in `with-scope.ts`)
 * grants this. MCP device-flow JWTs need explicit `mcp.propose.*` —
 * matches the POST/DELETE write convention.
 */
const revokeUseCase = new RevokeScopedSessionUseCase(container.scopedSessionRepo);

async function deleteHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authPayload!.userId;
    const rawSessionId = (
      req.query as Record<string, string | string[] | undefined>
    ).sessionId;
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
    const parsed = RevokeScopedSessionParamsSchema.parse({ sessionId });
    const result = await revokeUseCase.execute({
      userId,
      sessionId: parsed.sessionId,
    });
    sendResponse(res, Response.ok({ session: toScopedSessionDto(result.session) }));
  } catch (error) {
    if (error instanceof ZodError) {
      sendResponse(res, Response.fromZodError(error));
      return;
    }
    if (error instanceof ApplicationHttpError) {
      sendResponse(res, Response.fromError(error, error.statusCode));
      return;
    }
    // Match createHandler/createGetHandler's logging behavior so
    // genuinely unexpected errors leave a triage trail.
    log.error({ err: error }, 'Unhandled error');
    sendResponse(res, Response.internalServerError());
  }
}

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method === 'DELETE') {
    return deleteHandler(req, res);
  }
  sendResponse(res, Response.methodNotAllowed('DELETE'));
};

export default withCors(withAuth(withScope(['mcp.propose.*'])(router)));
