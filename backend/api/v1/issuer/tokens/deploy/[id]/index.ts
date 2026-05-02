/**
 * GET /v1/issuer/tokens/deploy/:id
 *
 * Phase 9.A · Expansion (F2) — durable status fallback for the deploy
 * job. The wizard's SSE channel is the primary feed, but a tab refresh
 * mid-deploy or a proxy timeout can drop it; this endpoint returns the
 * persisted row so the wizard can re-paint state from the DB.
 */
import { container } from '../../../../../../src/infrastructure/container.js';
import { ApplicationHttpError } from '../../../../../../src/core/errors.js';
import { createGetHandler } from '../../../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../../../src/interface/middleware/with-cors.js';
import { withRole } from '../../../../../../src/interface/middleware/with-role.js';
import { Response } from '../../../../../../src/interface/response.js';

const handler = createGetHandler({
  operationName: 'GetIssuerTokenDeploy',
  execute: async (req, authPayload) => {
    const id = req.query.id as string;
    if (!id) {
      throw ApplicationHttpError.badRequest('Missing deploy id');
    }
    const deploy = await container.issuerTokenDeployRepo.findById(id);
    if (!deploy) {
      throw ApplicationHttpError.notFound('Deploy not found');
    }
    if (deploy.userId !== authPayload!.userId) {
      throw ApplicationHttpError.forbidden(
        "Cannot read another user's deploy",
      );
    }
    return Response.ok({
      id: deploy.id,
      symbol: deploy.symbol,
      status: deploy.status,
      last_step: deploy.lastStep,
      result_token_address: deploy.resultTokenAddress,
      error_message: deploy.errorMessage,
      created_at: deploy.createdAt.toISOString(),
      completed_at: deploy.completedAt?.toISOString() ?? null,
    });
  },
});

export default withCors(withAuth(withRole('issuer', handler)));
