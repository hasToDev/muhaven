import {
  GetScopedSessionQuerySchema,
  MintScopedSessionDtoSchema,
  toScopedSessionDto,
} from '../../../../src/application/dto/agent/policy.dto.js';
import { GetActiveScopedSessionUseCase } from '../../../../src/application/use-case/agent/policy/get-active-scoped-session.use-case.js';
import { MintScopedSessionUseCase } from '../../../../src/application/use-case/agent/policy/mint-scoped-session.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import {
  createHandler,
  sendResponse,
  type AuthenticatedRequest,
} from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../src/interface/response.js';
import { ApplicationHttpError } from '../../../../src/core/errors.js';
import { getLogger } from '../../../../src/core/logger.js';
import {
  getEnv,
  getYieldSnapshotAddresses,
  parseTokenAddressMap,
} from '../../../../src/core/config.js';
import { ZodError } from 'zod';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const getLog = getLogger('GetActiveScopedSession');

/**
 * Wave 5 Path D Slice 2 Commit 2.A — backend mirror of the broker
 * keystore's policy snapshot.
 *
 *   POST /api/v1/agent/policy/scoped-session                — mint
 *   GET  /api/v1/agent/policy/scoped-session?surface=mcp    — read latest active
 *
 * DELETE for revoke lives in the sibling `scoped-session/[sessionId].ts`
 * (dynamic-segment file required by the dev-server's `[param]` route
 * convention; see `backend/src/dev-server.ts::scanRoutes` lines 56-76).
 *
 * Per-verb scope gating (operator-confirmed "reuse mcp.read.*"):
 *
 *   GET  → mcp.read.*    (existing MCP device-flow JWTs already grant
 *                         this via wildcard; Commit 2.B's MCP auto-sync
 *                         doesn't need a JWT re-issue. SIWE/passkey JWTs
 *                         lack a `scope` claim and fall through per the
 *                         `with-scope.ts` legacy-token full-access path.)
 *   POST → mcp.propose.* (write — SIWE/passkey JWTs fall through; MCP
 *                         read-only JWTs cannot mint, as intended.)
 *
 * The DELETE sibling carries `mcp.propose.*` (write); see that file.
 */

const mintUseCase = new MintScopedSessionUseCase(
  container.agentStateRepo,
  container.scopedSessionRepo,
  container.appendAuditEvent,
);

// Wave 5 Slice 1 (MCP sell) — pass the per-token RedemptionQueue addresses
// (so the GET-mirror read can derive queued-sell caps + queue targets) and
// the audit sink (for the one-time platform-derived-consent provenance row).
// Wave 5 Slice 2a (autonomous claim) — also pass the YieldSnapshot proxy
// addresses so the same read derives the claimYield cap + snapshot targets.
const getActiveUseCase = new GetActiveScopedSessionUseCase(
  container.scopedSessionRepo,
  Object.values(parseTokenAddressMap(getEnv().REDEMPTION_QUEUE_BY_TOKEN_JSON)),
  container.appendAuditEvent,
  getYieldSnapshotAddresses(),
);

const postHandler = createHandler({
  operationName: 'MintScopedSession',
  schema: MintScopedSessionDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const userId = authPayload!.userId;
    const result = await mintUseCase.execute({ userId, dto });
    return Response.created({ session: toScopedSessionDto(result.session) });
  },
});

/**
 * Custom GET handler (not `createGetHandler`) because we Zod-parse the
 * query string instead of the body. Mirrors the `/policy/state` pattern
 * where `query.surface` is parsed inline.
 */
async function getHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authPayload!.userId;
    const rawQuery = req.query as Record<string, string | string[] | undefined>;
    const surface = Array.isArray(rawQuery.surface) ? rawQuery.surface[0] : rawQuery.surface;
    const parsed = GetScopedSessionQuerySchema.parse({ surface });
    const session = await getActiveUseCase.execute({
      userId,
      surface: parsed.surface,
    });
    sendResponse(
      res,
      Response.ok({ session: session ? toScopedSessionDto(session) : null }),
    );
  } catch (error) {
    if (error instanceof ZodError) {
      sendResponse(res, Response.fromZodError(error));
      return;
    }
    if (error instanceof ApplicationHttpError) {
      sendResponse(res, Response.fromError(error, error.statusCode));
      return;
    }
    // Match createHandler/createGetHandler's logging behavior so genuinely
    // unexpected errors leave a triage trail. Without this, the custom
    // handler swallows the failure as a generic 500 with no stack.
    getLog.error({ err: error }, 'Unhandled error');
    sendResponse(res, Response.internalServerError());
  }
}

const getRoute = withScope(['mcp.read.*'])(getHandler);
const postRoute = withScope(['mcp.propose.*'])(postHandler);

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  switch (req.method) {
    case 'GET':
      return getRoute(req, res);
    case 'POST':
      return postRoute(req, res);
    default:
      sendResponse(res, Response.methodNotAllowed('GET, POST'));
      return;
  }
};

export default withCors(withAuth(router));
