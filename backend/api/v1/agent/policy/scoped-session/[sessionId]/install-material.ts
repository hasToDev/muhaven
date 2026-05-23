import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ZodError } from 'zod';
import {
  GetInstallMaterialQuerySchema,
  RevokeScopedSessionParamsSchema,
  toScopedSessionInstallMaterialDto,
} from '../../../../../../src/application/dto/agent/policy.dto.js';
import { GetScopedSessionInstallMaterialUseCase } from '../../../../../../src/application/use-case/agent/policy/get-scoped-session-install-material.use-case.js';
import { container } from '../../../../../../src/infrastructure/container.js';
import { sendResponse } from '../../../../../../src/interface/handler-factory.js';
import { withCors } from '../../../../../../src/interface/middleware/with-cors.js';
import { withServiceSecret } from '../../../../../../src/interface/middleware/with-service-secret.js';
import { Response } from '../../../../../../src/interface/response.js';
import { MissingEncryptionKeyError } from '../../../../../../src/infrastructure/repository/postgres/pgcrypto.js';
import { ApplicationHttpError } from '../../../../../../src/core/errors.js';
import { getLogger } from '../../../../../../src/core/logger.js';

const log = getLogger('GetScopedSessionInstallMaterial');

/**
 * Wave 5 Option D · Commit 2 — internal-only install-material reveal.
 *
 *   GET /api/v1/agent/policy/scoped-session/:sessionId/install-material?userId=...
 *
 * **Auth**: shared service secret `BROKER_CALLBACK_SERVICE_SECRET` in
 * `Authorization: Bearer <secret>`. Browser clients never see this
 * route — only the C3 MCP server (when its Path D probe hits
 * `enable_status === 'pending'` and needs to compose the MODE.ENABLE
 * UserOp).
 *
 * The shared secret is the CALLER gate ("are you the MCP server?").
 * The required `userId` query parameter is the OWNERSHIP gate
 * (defense-in-depth: a service-secret holder can't peek at OTHER
 * users' install material by varying the sessionId). The repository
 * layer re-checks `user_id = $1` in the SELECT.
 *
 * **Why GET + body-less + query userId** (vs POST + JSON body): the
 * route is idempotent + cacheable in principle (the install material
 * is immutable post-mint; only the lifecycle fields change). GET keeps
 * the wire shape boring. The userId is in the query string (not the
 * path) so the route pattern stays clean — `[sessionId]/install-
 * material` matches what the dev-server scanner produces.
 *
 * **Response shapes**:
 *   - 200 + ScopedSessionInstallMaterialDto when the row exists +
 *     ownership matches.
 *   - 404 when the row doesn't exist OR ownership mismatches
 *     (uniform response defeats sessionId-existence side channels).
 *   - 503 when `OPTION_D_C2_ENCRYPTION_KEY` is unset (pgcrypto can't
 *     decrypt without the key).
 *   - 401 from `withServiceSecret` when the bearer is missing /
 *     wrong-length / wrong-value.
 *   - 503 from `withServiceSecret` when `BROKER_CALLBACK_SERVICE_SECRET`
 *     is unset (route inactive until the operator wires the secret).
 *   - 400 when the query schema rejects (malformed userId).
 *
 * **Method allowance**: GET only — the verb check sits INSIDE
 * `withServiceSecret` so an unauthenticated POST/PUT/DELETE gets the
 * same 401/503 response shape as an unauthenticated GET. Defends
 * against route-fingerprinting probes.
 */

const useCase = new GetScopedSessionInstallMaterialUseCase(
  container.scopedSessionRepo,
);

async function getHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    const rawSessionId = (
      req.query as Record<string, string | string[] | undefined>
    ).sessionId;
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
    const params = RevokeScopedSessionParamsSchema.parse({ sessionId });

    const rawUserId = (req.query as Record<string, string | string[] | undefined>)
      .userId;
    const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
    const query = GetInstallMaterialQuerySchema.parse({ userId });

    const material = await useCase.execute({
      sessionId: params.sessionId,
      userId: query.userId,
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
      // 503 — distinct from "secret missing" (also 503) so an operator
      // running through the runbook can disambiguate.
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

const protectedHandler = withServiceSecret(
  {
    envVar: 'BROKER_CALLBACK_SERVICE_SECRET',
    serviceName: 'Broker Callback',
  },
  async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    if (req.method !== 'GET') {
      sendResponse(res, Response.methodNotAllowed('GET'));
      return;
    }
    return getHandler(req, res);
  },
);

export default withCors(protectedHandler);
