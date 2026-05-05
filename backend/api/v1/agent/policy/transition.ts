import {
  CommitTierTransitionDtoSchema,
  RequestTierTransitionDtoSchema,
  toUserStateDto,
} from '../../../../src/application/dto/agent/policy.dto.js';
import { GetPolicyStateUseCase } from '../../../../src/application/use-case/agent/policy/get-policy-state.use-case.js';
import { AppendAuditEventUseCase } from '../../../../src/application/use-case/agent/policy/append-audit-event.use-case.js';
import { ConfirmTokenService } from '../../../../src/application/use-case/agent/policy/confirm-token.service.js';
import {
  CommitTierTransitionUseCase,
  RequestTierTransitionUseCase,
} from '../../../../src/application/use-case/agent/policy/transition-tier.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import {
  createHandler,
  sendResponse,
} from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { withScope } from '../../../../src/interface/middleware/with-scope.js';
import { Response } from '../../../../src/interface/response.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const getPolicyState = new GetPolicyStateUseCase(container.agentStateRepo);
const appendAudit = new AppendAuditEventUseCase(container.agentAuditRepo);
const confirmTokens = new ConfirmTokenService(container.agentConfirmTokenRepo);

const requestUseCase = new RequestTierTransitionUseCase(
  container.agentStateRepo,
  getPolicyState,
  confirmTokens,
  appendAudit,
);

const commitUseCase = new CommitTierTransitionUseCase(
  container.agentStateRepo,
  getPolicyState,
  confirmTokens,
  appendAudit,
);

/**
 * POST /api/v1/agent/policy/transition (no token) — issue confirmation
 * POST /api/v1/agent/policy/transition (with token) — commit
 *
 * Two-stage flow per ADR-0 + R-3: client requests transition, gets a
 * single-use confirmation token + actionHash, prompts the user for
 * passkey-bound confirmation, then re-posts with the token to commit.
 *
 * Step-down transitions (PolicyBound → Confirm, Confirm → Advisory)
 * skip the token requirement and apply immediately — they only narrow
 * agent capability and a malicious replay can't mint new powers.
 */
const requestHandler = createHandler({
  operationName: 'RequestAgentTierTransition',
  schema: RequestTierTransitionDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const userId = authPayload!.userId;
    const result = await requestUseCase.execute({
      userId,
      surface: dto.surface,
      targetTier: dto.targetTier,
    });
    if (!result.requiresConfirmation) {
      return Response.ok({
        requiresConfirmation: false,
        state: toUserStateDto(result.state),
      });
    }
    return Response.ok({
      requiresConfirmation: true,
      confirmation: {
        token: result.confirmation.token,
        actionHash: result.confirmation.actionHash,
        expiresAt: result.confirmation.expiresAt.toISOString(),
      },
    });
  },
});

const commitHandler = createHandler({
  operationName: 'CommitAgentTierTransition',
  schema: CommitTierTransitionDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const userId = authPayload!.userId;
    const state = await commitUseCase.execute({
      userId,
      surface: dto.surface,
      targetTier: dto.targetTier,
      confirmationToken: dto.confirmationToken,
    });
    return Response.ok({ state: toUserStateDto(state) });
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'POST') {
    sendResponse(res, Response.badRequest('Method not allowed'));
    return;
  }
  const body = req.body;
  const hasToken =
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { confirmationToken?: unknown }).confirmationToken === 'string';
  return hasToken ? commitHandler(req, res) : requestHandler(req, res);
};

// Wave 4 P3 ADR-3 D2: device-flow JWTs need mcp.propose.*; SIWE tokens fall through.
export default withCors(withAuth(withScope(['mcp.propose.*'])(router)));
