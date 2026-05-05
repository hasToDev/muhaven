import { BuildPermissionTemplateDtoSchema } from '../../../../src/application/dto/agent/policy.dto.js';
import { BuildPermissionTemplateUseCase } from '../../../../src/application/use-case/agent/policy/build-permission-template.use-case.js';
import {
  createHandler,
  sendResponse,
} from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../src/interface/response.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const useCase = new BuildPermissionTemplateUseCase();

/**
 * POST /api/v1/agent/policy/permission-template
 *
 * Returns the per-tier `@zerodev/permissions` validator template the
 * frontend should install via `kernel.installValidator(...)`. Per
 * ADR-1, validators are immutable post-install; the frontend treats
 * each call to this endpoint as producing a *new* version, not a patch
 * to the existing one. The user must `uninstallPlugin` before
 * installing a different template.
 *
 * P0 deliberately does NOT mint a session key here — minting requires
 * a passkey signature, which lives in the browser. We only emit the
 * description.
 */
const postHandler = createHandler({
  operationName: 'BuildAgentPermissionTemplate',
  schema: BuildPermissionTemplateDtoSchema,
  execute: async (dto) => {
    const template = useCase.execute({
      tier: dto.tier,
      actions: dto.actions,
      ttlSec: dto.ttlSec,
    });
    return Response.ok({ template: useCase.serialize(template) });
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'POST') {
    sendResponse(res, Response.badRequest('Method not allowed'));
    return;
  }
  return postHandler(req, res);
};

// Wave 4 P3 ADR-3 D2: device-flow JWTs need mcp.propose.*; SIWE tokens fall through.
export default withCors(withAuth(withScope(['mcp.propose.*'])(router)));
