import {
  ResumeDtoSchema,
  toUserStateDto,
} from '../../../../src/application/dto/agent/policy.dto.js';
import { GetPolicyStateUseCase } from '../../../../src/application/use-case/agent/policy/get-policy-state.use-case.js';
import { AppendAuditEventUseCase } from '../../../../src/application/use-case/agent/policy/append-audit-event.use-case.js';
import { ResumeAgentUseCase } from '../../../../src/application/use-case/agent/policy/pause-agent.use-case.js';
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
const resumeUseCase = new ResumeAgentUseCase(container.agentStateRepo, getPolicyState, appendAudit);

const resumeHandler = createHandler({
  operationName: 'ResumeAgent',
  schema: ResumeDtoSchema,
  execute: async (dto, _req, authPayload) => {
    const userId = authPayload!.userId;
    await resumeUseCase.execute({ userId, surface: dto.surface });
    const next = await getPolicyState.forSurface(userId, dto.surface);
    return Response.ok({ state: toUserStateDto(next) });
  },
});

const router = async (req: VercelRequest, res: VercelResponse): Promise<void> => {
  if (req.method !== 'POST') {
    sendResponse(res, Response.badRequest('Method not allowed'));
    return;
  }
  return resumeHandler(req, res);
};

// Wave 4 P3 ADR-3 D2: device-flow JWTs need mcp.propose.*; SIWE tokens fall through.
export default withCors(withAuth(withScope(['mcp.propose.*'])(router)));
