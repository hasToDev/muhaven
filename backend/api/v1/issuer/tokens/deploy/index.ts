/**
 * POST /v1/issuer/tokens/deploy
 *
 * Phase 9.A · Expansion (F2) — kicks off a self-serve token deploy.
 * Returns 202 + `{ deploy_id, status: 'running' }`. The wizard then
 * subscribes to `/v1/issuer/tokens/deploy/[id]/events` (SSE) for
 * progress.
 */
import { DeployTokenDtoSchema } from '../../../../../src/application/dto/issuer/deploy-token.dto.js';
import { DeployTokenUseCase } from '../../../../../src/application/use-case/issuer/deploy-token.use-case.js';
import { container } from '../../../../../src/infrastructure/container.js';
import { ApplicationHttpError } from '../../../../../src/core/errors.js';
import { createHandler } from '../../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../../src/interface/middleware/with-cors.js';
import { withRole } from '../../../../../src/interface/middleware/with-role.js';

const handler = createHandler({
  operationName: 'DeployIssuerToken',
  schema: DeployTokenDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const library = container.getDeployLibrary();
    if (!library) {
      throw ApplicationHttpError.serviceUnavailable(
        'Issuer onboarding deploy library disabled — set PLATFORM_DEPLOYER_PRIVATE_KEY + platform addresses',
      );
    }
    const useCase = new DeployTokenUseCase(
      container.userRepo,
      container.issuerTokenDeployRepo,
      library,
      container.rwaTokenRepo,
    );
    const result = await useCase.start(authPayload!.userId, dto);
    return {
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  },
});

export default withCors(withAuth(withRole('issuer', handler)));
