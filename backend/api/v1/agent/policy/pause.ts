import {
  PauseDtoSchema,
  type PauseResponseDto,
} from '../../../../src/application/dto/agent/policy.dto.js';
import { Surface, SURFACE_VALUES } from '../../../../src/domain/agent/model/surface.enum.js';
import { Trigger } from '../../../../src/domain/agent/model/trigger.enum.js';
import { GetPolicyStateUseCase } from '../../../../src/application/use-case/agent/policy/get-policy-state.use-case.js';
import { AppendAuditEventUseCase } from '../../../../src/application/use-case/agent/policy/append-audit-event.use-case.js';
import { PauseAgentUseCase } from '../../../../src/application/use-case/agent/policy/pause-agent.use-case.js';
import { container } from '../../../../src/infrastructure/container.js';
import {
  createHandler,
  sendResponse,
} from '../../../../src/interface/handler-factory.js';
import { withAuth } from '../../../../src/interface/middleware/with-auth.js';
import { withCors } from '../../../../src/interface/middleware/with-cors.js';
import { Response } from '../../../../src/interface/response.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const getPolicyState = new GetPolicyStateUseCase(container.agentStateRepo);
const appendAudit = new AppendAuditEventUseCase(container.agentAuditRepo);
const pauseUseCase = new PauseAgentUseCase(container.agentStateRepo, getPolicyState, appendAudit);

/**
 * Explicit `/pause` kill-switch (T-1). Idempotent — pausing a paused
 * surface is a no-op + audit entry. Without `surface` in the body all
 * four surfaces are paused — equivalent to a panic-button cascade.
 *
 * Cascading triggers (T-5, T-6) are NOT exposed on this endpoint —
 * KYC revocations come in via webhooks (P7), account-recovery comes in
 * via the ZeroDev plugin-reinstall webhook detection. This endpoint
 * is the user-initiated path only.
 */
const pauseHandler = createHandler({
  operationName: 'PauseAgent',
  schema: PauseDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const userId = authPayload!.userId;
    const surfaces: Surface[] = dto.surface ? [dto.surface] : [...SURFACE_VALUES];

    const allPaused: Surface[] = [];
    for (const surface of surfaces) {
      const result = await pauseUseCase.execute({
        userId,
        surface,
        trigger: Trigger.ExplicitPause,
        metadata: { source: 'explicit-user-pause' },
      });
      // pauseUseCase.execute may itself cascade if a future trigger
      // expands the cascade list — flatten by union to defend against
      // duplicates.
      for (const s of result.pausedSurfaces) if (!allPaused.includes(s)) allPaused.push(s);
    }

    const response: PauseResponseDto = {
      pausedSurfaces: allPaused,
      cascade: !dto.surface,
    };
    return Response.ok(response);
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'POST') {
    sendResponse(res, Response.badRequest('Method not allowed'));
    return;
  }
  return pauseHandler(req, res);
};

export default withCors(withAuth(router));
