import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ZodError } from 'zod';
import {
  RevokeScopedSessionParamsSchema,
  toScopedSessionInstallMaterialDto,
} from '../../../../../../src/application/dto/agent/policy.dto.js';
import { GetScopedSessionInstallMaterialUseCase } from '../../../../../../src/application/use-case/agent/policy/get-scoped-session-install-material.use-case.js';
import { container } from '../../../../../../src/infrastructure/container.js';
import {
  sendResponse,
  type AuthenticatedRequest,
} from '../../../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../../../src/interface/response.js';
import { MissingEncryptionKeyError } from '../../../../../../src/infrastructure/repository/postgres/pgcrypto.js';
import { ApplicationHttpError } from '../../../../../../src/core/errors.js';
import { getLogger } from '../../../../../../src/core/logger.js';

const log = getLogger('GetScopedSessionInstallMaterial');

/**
 * Wave 5 Option D · Commit 2 (auth model rev. in C3 third commit) —
 * install-material reveal for the MCP server's MODE.ENABLE UserOp.
 *
 *   GET /api/v1/agent/policy/scoped-session/:sessionId/install-material
 *
 * **Auth (C3 rev.)**: the caller's own **user JWT** (`withAuth` +
 * `withScope(['mcp.propose.*'])`). The owning userId is taken from the
 * verified JWT subject — NOT a query param + NOT a shared service
 * secret. Rationale (third-commit refactor): the actual consumer is
 * the MCP server, which already holds the user's device-flow JWT
 * (scopes `mcp.read.* + mcp.propose.*`). The C2 design gated this on
 * the shared `BROKER_CALLBACK_SERVICE_SECRET` on the assumption the
 * consumer would be the broker daemon — but a shared service secret
 * does NOT scale to a multi-user install (a fresh `npm i -g
 * @muhaven/mcp` user has no provisioning path to obtain it, and N-way
 * distributing one secret is a leak-amplification risk). Gating on the
 * user's own JWT is the correct per-user model: a user fetches THEIR
 * OWN session's install material, nothing else.
 *
 * **Scope = `mcp.propose.*`** (not `mcp.read.*`): the install material
 * (`enable_data` + `enable_sig`) directly enables an on-chain write
 * (the PermissionValidator install), so it sits behind the same scope
 * the autonomous buy itself requires — least-privilege.
 *
 * **Ownership**: the use-case re-checks `user_id = $1` at the repo
 * layer. With JWT-derived userId this is now belt-and-suspenders (the
 * JWT subject IS the userId), but kept as defense-in-depth against a
 * future caller that passes a different userId.
 *
 * **`enable_data`/`enable_sig` exposure**: these decrypt server-side
 * (pgcrypto) inside the SELECT and ship over TLS to the user's own
 * authenticated session. The user generated this material (their
 * passkey signed the enable typed-data); exposing it back to their own
 * `mcp.propose.*`-scoped JWT is appropriate. The default scoped-session
 * GET still REDACTS these columns — this subroute is the sole reveal
 * path.
 *
 * **Response shapes**:
 *   - 200 + ScopedSessionInstallMaterialDto when the row exists +
 *     belongs to the JWT subject.
 *   - 404 when the row doesn't exist OR isn't owned by the caller
 *     (uniform response defeats sessionId-existence side channels).
 *   - 503 when `OPTION_D_C2_ENCRYPTION_KEY` is unset (pgcrypto can't
 *     decrypt without the key).
 *   - 401 from `withAuth` (missing/invalid JWT) / 403 from `withScope`
 *     (JWT lacks `mcp.propose.*`).
 *   - 405 for non-GET methods.
 */

const useCase = new GetScopedSessionInstallMaterialUseCase(
  container.scopedSessionRepo,
);

async function getHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authPayload!.userId;

    const rawSessionId = (
      req.query as Record<string, string | string[] | undefined>
    ).sessionId;
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
    const params = RevokeScopedSessionParamsSchema.parse({ sessionId });

    const material = await useCase.execute({
      sessionId: params.sessionId,
      userId,
    });
    if (!material) {
      // Uniform 404 across "not found" and "not owned" — see route
      // JSDoc for the side-channel rationale.
      sendResponse(res, Response.notFound('scoped session not found'));
      return;
    }
    sendResponse(
      res,
      Response.ok({ installMaterial: toScopedSessionInstallMaterialDto(material) }),
    );
  } catch (error) {
    if (error instanceof ZodError) {
      sendResponse(res, Response.fromZodError(error));
      return;
    }
    if (error instanceof MissingEncryptionKeyError) {
      // 503 when OPTION_D_C2_ENCRYPTION_KEY is unset — pgcrypto can't
      // decrypt enable_data/enable_sig without it.
      sendResponse(res, {
        statusCode: 503,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Install material unavailable',
          status: 503,
          detail: error.message,
        }),
      });
      return;
    }
    if (error instanceof ApplicationHttpError) {
      sendResponse(res, Response.fromError(error, error.statusCode));
      return;
    }
    log.error({ err: error }, 'Unhandled error');
    sendResponse(res, Response.internalServerError());
  }
}

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'GET') {
    sendResponse(res, Response.methodNotAllowed('GET'));
    return;
  }
  return getHandler(req, res);
};

export default withCors(withAuth(withScope(['mcp.propose.*'])(router)));
